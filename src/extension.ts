import * as vscode from 'vscode';
import { readFile, FileToolsError, getWorkspaceRoot } from './tools/fileTools';
import { registerProposedContentProvider } from './diff/diffContentProvider';
import { runOptimizeAndTest } from './agent/optimizeAndTest';
import { runRaisePR } from './git/raisePR';
import { AgentMode, buildToolDefinitions, executeTool, listWorkspaceFiles, MAX_CONTEXT_CHARS, ToolContext } from './agent/tools';
import { EditManager, ChangeSummary, PendingChange } from './edits/editManager';
import { CommandRunner, CommandResult } from './terminal/commandRunner';
import { getWebviewContent } from './webview/chatHtml';

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'qwen3:14b';
const DEFAULT_KEEP_ALIVE = '30m';
const MODEL_STATE_KEY = 'localCodingAgent.selectedModel';
const MODE_STATE_KEY = 'localCodingAgent.mode';

interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: OllamaToolCall[];
    tool_name?: string;
}

interface ChatStats {
    promptTokens: number;
    outputTokens: number;
    tokensPerSecond: number;
    totalSeconds: number;
}

/** Sampling options that stop qwen3 & co. from looping on the same tokens. */
const ANTI_REPEAT_OPTIONS = { presence_penalty: 1.5, repeat_penalty: 1.1, repeat_last_n: 256 };
/** Stronger settings used for one automatic retry after a repetition abort. */
const RECOVERY_OPTIONS = { presence_penalty: 1.8, repeat_penalty: 1.25, repeat_last_n: 512, temperature: 0.8 };
/** Hard cap on generated tokens per step so a runaway answer can't spin forever. */
const MAX_OUTPUT_TOKENS = 8192;
/** Rough characters-per-token ratio used to estimate prompt size. */
const CHARS_PER_TOKEN = 3.5;
/** Tool results longer than this are shortened once the context gets full. */
const COMPACT_KEEP_CHARS = 600;

interface OllamaToolCall {
    function: {
        name: string;
        arguments: Record<string, unknown> | string;
    };
}

interface ActiveFileContext {
    relativePath: string;
    content: string;
    truncated: boolean;
}

function settings() {
    const config = vscode.workspace.getConfiguration('localCodingAgent');
    return {
        ollamaUrl: config.get<string>('ollamaUrl', DEFAULT_OLLAMA_URL).replace(/\/$/, ''),
        keepAlive: config.get<string>('keepAlive', DEFAULT_KEEP_ALIVE),
        contextLength: config.get<number>('contextLength', 32768),
        thinking: config.get<boolean>('thinking', false),
        maxAgentSteps: config.get<number>('maxAgentSteps', 25),
        commandTimeoutSeconds: config.get<number>('commandTimeoutSeconds', 120)
    };
}

/**
 * Sidebar chat view. Two modes:
 * - Ask: read-only tools; code blocks can be applied to a file on demand.
 * - Agent: the model edits/creates files itself (each change applied in place
 *   at the exact spot, then approved or undone by the developer) and can run
 *   terminal commands once the developer approves them.
 */
class LocalCodingAgentViewProvider implements vscode.WebviewViewProvider {

    public static readonly viewType = 'localCodingAgent.chatView';

    private view?: vscode.WebviewView;
    private currentModel: string;
    private mode: AgentMode;
    private abortController?: AbortController;
    private busy = false;
    private history: ChatMessage[] = [];
    /** Last file attached to the conversation, so an unchanged file isn't resent every turn. */
    private lastAttached?: { relativePath: string; content: string };
    /** Models that rejected the "think" flag; we stop sending it to them. */
    private readonly noThinkSupport = new Set<string>();

    private readonly commandApprovals = new Map<string, { command: string; resolve: (command: string | undefined) => void }>();
    private approvalCounter = 0;

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly edits: EditManager,
        private readonly runner: CommandRunner
    ) {
        const config = vscode.workspace.getConfiguration('localCodingAgent');
        this.currentModel =
            this.context.workspaceState.get<string>(MODEL_STATE_KEY) ??
            config.get<string>('model', DEFAULT_MODEL);
        this.mode = this.context.workspaceState.get<AgentMode>(MODE_STATE_KEY) ?? 'ask';

        this.context.subscriptions.push(
            this.edits.onDidChangeStatus(change => this.postChange(change)),
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('localCodingAgent.thinking')) {
                    this.post({ type: 'thinkingChanged', enabled: settings().thinking });
                }
            })
        );
    }

    public getCurrentModel(): string {
        return this.currentModel;
    }

    public getOllamaUrl(): string {
        return settings().ollamaUrl;
    }

    public async setCurrentModel(model: string): Promise<void> {
        this.currentModel = model;
        await this.context.workspaceState.update(MODEL_STATE_KEY, model);
        this.view?.webview.postMessage({ type: 'modelChanged', model });
    }

    public async setMode(mode: AgentMode): Promise<void> {
        this.mode = mode;
        await this.context.workspaceState.update(MODE_STATE_KEY, mode);
        this.view?.webview.postMessage({ type: 'modeChanged', mode });
    }

    public reveal(): void {
        this.view?.show?.(true);
    }

    public resolveWebviewView(webviewView: vscode.WebviewView): void {

        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
        };

        const includeContextByDefault = vscode.workspace
            .getConfiguration('localCodingAgent')
            .get<boolean>('includeActiveFileByDefault', true);

        webviewView.webview.html = getWebviewContent(
            webviewView.webview,
            this.context.extensionUri,
            this.currentModel,
            this.mode,
            includeContextByDefault
        );

        webviewView.webview.onDidReceiveMessage(
            message => this.onMessage(message).catch(error => {
                const text = error instanceof Error ? error.message : String(error);
                this.post({ type: 'notice', ok: false, text });
            }),
            undefined,
            this.context.subscriptions
        );

        void this.postModelList();
    }

    private post(message: unknown): void {
        void this.view?.webview.postMessage(message);
    }

    private postChange(change: ChangeSummary): void {
        this.post({ type: 'change', change });
        this.post({ type: 'pendingCount', count: this.edits.pending().length });
    }

    private async onMessage(message: any): Promise<void> {

        switch (message.type) {

            case 'ready':
            case 'refreshModels':
                await this.postModelList();
                this.post({ type: 'modeChanged', mode: this.mode });
                this.post({ type: 'thinkingChanged', enabled: settings().thinking });
                this.post({ type: 'pendingCount', count: this.edits.pending().length });
                break;

            case 'setModel':
                await this.setCurrentModel(message.model);
                break;

            case 'setMode':
                await this.setMode(message.mode === 'agent' ? 'agent' : 'ask');
                break;

            case 'sendMessage':
                await this.handleUserMessage(String(message.text ?? ''), message.includeContext !== false);
                break;

            case 'newChat':
                this.abortController?.abort();
                this.history = [];
                this.lastAttached = undefined;
                break;

            case 'setThinking':
                await vscode.workspace.getConfiguration('localCodingAgent')
                    .update('thinking', !!message.enabled, vscode.ConfigurationTarget.Global);
                break;

            case 'stopGeneration':
                this.abortController?.abort();
                break;

            case 'applyCode':
                await this.handleApplyCode(String(message.code ?? ''), message.suggestedPath);
                break;

            case 'approveChange':
                this.edits.approve(message.id);
                break;

            case 'undoChange':
                await this.undoChange(message.id);
                break;

            case 'showDiff':
                await this.edits.showDiff(message.id);
                break;

            case 'revealChange':
                await this.edits.reveal(message.id);
                break;

            case 'approveAll':
                this.edits.approveAll();
                break;

            case 'undoAll':
                await this.edits.undoAll();
                break;

            case 'commandDecision': {
                const pending = this.commandApprovals.get(message.id);
                if (pending) {
                    this.commandApprovals.delete(message.id);
                    const edited = typeof message.command === 'string' ? message.command.trim() : '';
                    pending.resolve(message.approved && edited ? edited : undefined);
                }
                break;
            }
        }
    }

    public async undoChange(id: string): Promise<void> {
        try {
            await this.edits.undo(id);
        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            vscode.window.showWarningMessage(`Local Coding Agent: ${text}`);
            // Re-render the card so its buttons become clickable again.
            const summary = this.edits.summary(id);
            if (summary) {
                this.postChange(summary);
            }
        }
    }

    private async postModelList(): Promise<void> {
        const models = await fetchOllamaModels(settings().ollamaUrl);
        this.post({
            type: 'modelList',
            models: models ?? [],
            connected: models !== null,
            currentModel: this.currentModel
        });
    }

    // ------------------------------------------------------------ agent loop

    private async handleUserMessage(text: string, includeContext: boolean): Promise<void> {

        if (!text.trim() || this.busy) {
            return;
        }

        const fileContext = includeContext ? getActiveFileContext() : undefined;
        if (fileContext) {
            this.post({ type: 'contextAttached', relativePath: fileContext.relativePath, truncated: fileContext.truncated });
        }

        this.history.push({ role: 'user', content: text + this.attachmentFor(fileContext) });
        this.abortController = new AbortController();
        this.busy = true;

        try {
            await this.runAgentLoop(this.abortController.signal);
        } finally {
            this.busy = false;
            this.cancelPendingApprovals();
        }
    }

    /**
     * The open file goes into the user message (not the system prompt) so the
     * system prompt never changes and Ollama can reuse its cached prompt
     * prefix between turns. An unchanged file is not sent again.
     */
    private attachmentFor(fileContext?: ActiveFileContext): string {
        if (!fileContext) {
            return '';
        }
        const last = this.lastAttached;
        if (last && last.relativePath === fileContext.relativePath && last.content === fileContext.content) {
            return `\n\n(Open file: ${fileContext.relativePath}, unchanged since it was shared above.)`;
        }
        this.lastAttached = { relativePath: fileContext.relativePath, content: fileContext.content };
        return `\n\nThe developer currently has this file open in the editor:\n\nFile: ${fileContext.relativePath}\n\`\`\`\n${fileContext.content}\n\`\`\`\n`;
    }

    /**
     * Keeps the conversation inside the context window. When the estimated
     * prompt gets close to num_ctx, the oldest long tool results and file
     * attachments are shortened (oldest first) instead of letting Ollama cut
     * off the start of the prompt, which drops the system instructions and
     * makes the model ramble or loop.
     */
    private compactHistory(numCtx: number, fixedChars: number): void {
        const budgetChars = numCtx * 0.7 * CHARS_PER_TOKEN;
        let total = fixedChars + this.history.reduce((sum, m) => sum + m.content.length, 0);
        // Never touch the latest user message: it holds the current request.
        let lastUser = -1;
        this.history.forEach((m, i) => { if (m.role === 'user') { lastUser = i; } });

        for (let i = 0; i < this.history.length && total > budgetChars; i++) {
            const m = this.history[i];
            if (i === lastUser || m.content.length <= COMPACT_KEEP_CHARS + 200) {
                continue;
            }
            if (m.role !== 'tool' && m.role !== 'user') {
                continue;
            }
            const shortened = m.content.slice(0, COMPACT_KEEP_CHARS) +
                '\n[...older content trimmed to save context; read it again with a tool if needed...]';
            total -= m.content.length - shortened.length;
            m.content = shortened;
            if (m.role === 'user') {
                this.lastAttached = undefined;
            }
        }
    }

    private async runAgentLoop(signal: AbortSignal): Promise<void> {

        const cfg = settings();
        const mode = this.mode;
        const model = this.currentModel;
        const maxSteps = mode === 'agent' ? Math.max(2, cfg.maxAgentSteps) : 6;

        const toolContext: ToolContext = {
            mode,
            edits: this.edits,
            signal,
            runCommandWithApproval: command => this.runCommandWithApproval(command, signal),
            onChange: (_change: PendingChange) => { /* cards are posted via onDidChangeStatus */ }
        };

        try {

            for (let step = 0; step < maxSteps; step++) {

                this.post({ type: 'status', text: `${model} is ${step === 0 ? 'thinking' : 'working'}...` });

                const systemMessage: ChatMessage = {
                    role: 'system',
                    content: mode === 'agent' ? AGENT_PROMPT : ASK_PROMPT
                };

                const allowTools = step < maxSteps - 1;
                const tools = allowTools ? buildToolDefinitions(mode) : undefined;

                this.compactHistory(cfg.contextLength, systemMessage.content.length + JSON.stringify(tools ?? []).length);

                const request = {
                    model,
                    signal,
                    messages: [systemMessage, ...this.history],
                    tools
                };

                let reply: { content: string; toolCalls: OllamaToolCall[] };
                try {
                    reply = await this.streamChat(request);
                } catch (error) {
                    // qwen3 sometimes gets stuck repeating itself and Ollama aborts
                    // the prediction. Retry once without thinking and with
                    // stronger anti-repeat sampling before giving up.
                    if (signal.aborted || !isRepetitionError(error)) {
                        throw error;
                    }
                    this.post({ type: 'notice', ok: false, text: 'The model got stuck repeating itself. Retrying with stricter settings…' });
                    reply = await this.streamChat({ ...request, recovery: true });
                }
                const { content, toolCalls } = reply;

                if (toolCalls.length === 0 || !allowTools) {
                    this.history.push({ role: 'assistant', content: stripThinking(content) });
                    break;
                }

                this.history.push({ role: 'assistant', content: stripThinking(content), tool_calls: toolCalls });

                for (const call of toolCalls) {

                    if (signal.aborted) {
                        break;
                    }

                    const args = parseToolArguments(call.function.arguments);
                    this.post({ type: 'toolCall', name: call.function.name, args });

                    const result = await executeTool(call.function.name, args, toolContext);
                    this.history.push({ role: 'tool', tool_name: call.function.name, content: result });

                    if (result.startsWith('Error')) {
                        this.post({ type: 'notice', ok: false, text: result.replace(/^Error running tool "[^"]+": /, '') });
                    }
                }

                if (signal.aborted) {
                    throw abortError();
                }
            }

            this.post({ type: 'complete' });

        } catch (error) {

            if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
                this.post({ type: 'endResponse' });
                this.post({ type: 'complete', stopped: true });
                return;
            }

            const message = error instanceof Error ? error.message : String(error);
            this.post({ type: 'error', text: message });
            vscode.window.showErrorMessage(`Ollama error: ${message}`);
        }
    }

    private async streamChat(req: {
        model: string;
        signal: AbortSignal;
        messages: ChatMessage[];
        tools?: unknown[];
        recovery?: boolean;
    }): Promise<{ content: string; toolCalls: OllamaToolCall[] }> {

        const cfg = settings();
        const wantThinking = cfg.thinking && !req.recovery;

        const send = (includeThink: boolean) => fetch(`${cfg.ollamaUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: req.signal,
            body: JSON.stringify({
                model: req.model,
                keep_alive: cfg.keepAlive,
                messages: req.messages.map(({ role, content, tool_calls, tool_name }) => ({ role, content, tool_calls, tool_name })),
                tools: req.tools,
                stream: true,
                // Thinking models (qwen3, deepseek-r1) reason silently before
                // answering, which can take a long time. It is off by default;
                // when on, the reasoning streams into a collapsible panel.
                ...(includeThink ? { think: wantThinking } : {}),
                options: {
                    // Ollama's default context window is small; agent runs need room
                    // for the system prompt, tool schemas and file contents.
                    num_ctx: cfg.contextLength,
                    num_predict: MAX_OUTPUT_TOKENS,
                    ...(req.recovery ? RECOVERY_OPTIONS : ANTI_REPEAT_OPTIONS)
                }
            })
        });

        let response = await send(!this.noThinkSupport.has(req.model));

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            // Models without thinking support may reject the "think" flag.
            if (response.status === 400 && /think/i.test(detail) && !this.noThinkSupport.has(req.model)) {
                this.noThinkSupport.add(req.model);
                response = await send(false);
            } else {
                throw new Error(`Ollama returned HTTP ${response.status}: ${detail || response.statusText}`);
            }
        }
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Ollama returned HTTP ${response.status}: ${detail || response.statusText}`);
        }
        if (!response.body) {
            throw new Error('Ollama response body is empty.');
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let content = '';
        const toolCalls: OllamaToolCall[] = [];
        let stats: ChatStats | undefined;

        this.post({ type: 'startResponse' });

        const handleLine = (line: string) => {
            if (!line.trim()) {
                return;
            }
            try {
                const data = JSON.parse(line);
                if (data.error) {
                    throw new Error(String(data.error));
                }
                if (data.message?.thinking) {
                    this.post({ type: 'thinking', text: data.message.thinking });
                }
                if (data.message?.content) {
                    content += data.message.content;
                    this.post({ type: 'token', text: data.message.content });
                }
                if (Array.isArray(data.message?.tool_calls)) {
                    toolCalls.push(...data.message.tool_calls);
                }
                if (data.done) {
                    stats = readStats(data);
                }
            } catch (error) {
                if (error instanceof SyntaxError) {
                    console.error('Failed to parse Ollama response:', line);
                    return;
                }
                throw error;
            }
        };

        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            lines.forEach(handleLine);
        }
        handleLine(buffer);

        this.post({ type: 'endResponse', stats });
        if (stats && stats.promptTokens >= cfg.contextLength * 0.9) {
            this.post({
                type: 'notice',
                ok: false,
                text: `The conversation is close to the ${cfg.contextLength}-token context window. Start a new chat or raise "Context Length" in settings for better answers.`
            });
        }
        return { content, toolCalls };
    }

    // --------------------------------------------------------------- commands

    private runCommandWithApproval(command: string, signal: AbortSignal): Promise<{ command: string; result: CommandResult } | undefined> {

        this.approvalCounter += 1;
        const id = `cmd-${Date.now().toString(36)}-${this.approvalCounter}`;

        return new Promise<string | undefined>(resolve => {
            this.commandApprovals.set(id, { command, resolve });
            this.post({ type: 'status', text: 'Waiting for you to approve a command...' });
            this.post({ type: 'commandApproval', id, command });
        }).then(async approved => {

            if (!approved || signal.aborted) {
                return undefined;
            }

            let cwd: string;
            try {
                cwd = getWorkspaceRoot().fsPath;
            } catch {
                this.post({ type: 'commandResult', id, command: approved, exitCode: null, cancelled: true, output: 'No workspace folder is open.' });
                return undefined;
            }

            this.post({ type: 'status', text: `Running: ${approved}` });
            const result = await this.runner.run(approved, cwd, settings().commandTimeoutSeconds * 1000, signal);

            this.post({
                type: 'commandResult',
                id,
                command: approved,
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                cancelled: result.cancelled,
                output: result.output.length > 4000 ? '…' + result.output.slice(-4000) : result.output
            });

            return { command: approved, result };
        });
    }

    private cancelPendingApprovals(): void {
        for (const [id, pending] of this.commandApprovals) {
            pending.resolve(undefined);
            this.post({ type: 'commandCancelled', id, command: pending.command });
        }
        this.commandApprovals.clear();
    }

    // ----------------------------------------------------------- Ask "Apply"

    /**
     * Applies a code block from the chat to a file, touching only what
     * changes: a full-file block is diffed and only the differing lines are
     * replaced; a snippet replaces the selection / goes in at the cursor.
     * The change then shows an Approve / Undo card like agent edits do.
     */
    private async handleApplyCode(code: string, suggestedPath?: string): Promise<void> {

        const editor = vscode.window.activeTextEditor;
        const activePath = editor && editor.document.uri.scheme === 'file'
            ? vscode.workspace.asRelativePath(editor.document.uri)
            : '';

        let relativePath = (suggestedPath ?? '').trim() || activePath;

        if (!relativePath) {
            relativePath = (await vscode.window.showInputBox({
                title: 'Local Coding Agent: Apply Code',
                prompt: 'File path to write, relative to the workspace root',
                placeHolder: 'src/main/java/com/example/Foo.java'
            }))?.trim() ?? '';
            if (!relativePath) {
                return;
            }
        }

        // Drop the "// path/to/File.ext" header line the model adds for us.
        const lines = code.split('\n');
        if (suggestedPath && lines[0].includes(suggestedPath)) {
            lines.shift();
        }
        const body = lines.join('\n').replace(/\n$/, '') + '\n';

        try {

            const isActive = !!editor && relativePath === activePath;

            if (isActive && editor && !editor.selection.isEmpty) {
                await this.edits.applyAtSelection(editor, body.replace(/\n$/, ''));
                return;
            }

            let existing: string | undefined;
            try {
                existing = (await readFile(relativePath)).content;
            } catch (error) {
                if (!(error instanceof FileToolsError && error.code === 'NOT_FOUND')) {
                    throw error;
                }
            }

            const existingLines = existing === undefined ? 0 : existing.split('\n').length;
            const looksPartial = existing !== undefined && existingLines > 15 && lines.length < existingLines * 0.5;

            if (looksPartial) {
                const choice = await vscode.window.showQuickPick(
                    [
                        { label: isActive ? 'Insert at cursor' : `Open ${relativePath} and insert at cursor`, value: 'cursor' },
                        { label: 'Treat as the whole file (only changed lines are replaced)', value: 'full' }
                    ],
                    { title: `This code looks like a snippet of ${relativePath}. How should it be applied?` }
                );
                if (!choice) {
                    return;
                }
                if (choice.value === 'cursor') {
                    const target = isActive && editor
                        ? editor
                        : await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.joinPath(getWorkspaceRoot(), relativePath)));
                    await this.edits.applyAtSelection(target, body);
                    return;
                }
            }

            await this.edits.applyFullContent(relativePath, body);

        } catch (error) {
            const text = error instanceof Error ? error.message : String(error);
            this.post({ type: 'notice', ok: false, text });
        }
    }
}

const ASK_PROMPT = `
You are a local coding assistant inside VS Code (Ask mode), with read-only tools
to explore the developer's project instead of guessing.

Tools:
- list_workspace_files: lists every file in the workspace.
- read_file: reads one file by its workspace-relative path.
- search_workspace: finds lines containing a text string across the project.

Use these tools to gather real context before answering questions about the
codebase. You cannot modify files in this mode. When you propose code, put it
in a fenced code block. When it is a complete file, start the block with a
comment naming its relative path (e.g. "// src/Foo.java") so the developer can
click Apply. The extension applies only the lines that differ. If the developer
wants you to make the changes yourself, tell them to switch to Agent mode.
Keep explanations short and technically accurate.
`;

const AGENT_PROMPT = `
You are an autonomous coding agent running inside VS Code (Agent mode). You
change the developer's project directly with tools. Every change you make is
shown to the developer, who approves or undoes it, so act confidently.

Tools:
- list_workspace_files, search_workspace, read_file: explore the project.
- edit_file(path, old_string, new_string): change an EXISTING file at one exact
  spot. old_string must be copied verbatim from the current file and be unique
  (include 2-3 surrounding lines). Make several small edit_file calls for
  separate changes. Never rewrite a whole file with it.
- create_file(path, content): create a NEW file.
- run_command(command): run a shell command in the workspace root, such as
  installing dependencies, building, running tests or git. The developer
  approves each command. Don't start servers or watchers that never exit.

Workflow:
1. Read the relevant files before editing them (never guess file contents).
2. Make the changes with edit_file / create_file. Do not paste code in chat
   instead of editing, and do not ask for permission; the developer reviews.
3. When useful, verify with run_command (build, tests, lint) and fix problems.
4. Finish with a short summary of what you changed and anything left to do.
If a tool returns an error, read it, fix your arguments and retry.
`;

function stripThinking(content: string): string {
    return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

function isRepetitionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /repeat limit|repetition|repeated/i.test(message);
}

function readStats(data: any): ChatStats {
    const evalSeconds = (data.eval_duration ?? 0) / 1e9;
    const outputTokens = data.eval_count ?? 0;
    return {
        promptTokens: data.prompt_eval_count ?? 0,
        outputTokens,
        tokensPerSecond: evalSeconds > 0 ? outputTokens / evalSeconds : 0,
        totalSeconds: (data.total_duration ?? 0) / 1e9
    };
}

function abortError(): Error {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
}

function parseToolArguments(raw: Record<string, unknown> | string): Record<string, unknown> {
    if (typeof raw !== 'string') {
        return raw ?? {};
    }
    try {
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function getActiveFileContext(): ActiveFileContext | undefined {

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
        return undefined;
    }

    const fullContent = editor.document.getText();
    const truncated = fullContent.length > MAX_CONTEXT_CHARS;

    return {
        relativePath: vscode.workspace.asRelativePath(editor.document.uri),
        content: truncated
            ? fullContent.slice(0, MAX_CONTEXT_CHARS) + '\n\n[...truncated, file too large...]'
            : fullContent,
        truncated
    };
}

/**
 * Queries Ollama's local model list (GET /api/tags). Returns null on any
 * failure so callers can treat it as "not connected".
 */
async function fetchOllamaModels(ollamaUrl: string): Promise<string[] | null> {

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);

    try {
        const response = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/tags`, { signal: controller.signal });
        if (!response.ok) {
            return null;
        }
        const data: any = await response.json();
        return Array.isArray(data?.models) ? data.models.map((m: any) => m.name).filter(Boolean) : [];
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

export function activate(context: vscode.ExtensionContext) {

    registerProposedContentProvider(context);

    const edits = new EditManager();
    const runner = new CommandRunner();
    context.subscriptions.push(edits, runner);

    const provider = new LocalCodingAgentViewProvider(context, edits, runner);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            LocalCodingAgentViewProvider.viewType,
            provider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    const register = (id: string, fn: (...args: any[]) => unknown) =>
        context.subscriptions.push(vscode.commands.registerCommand(id, fn));

    register('local-coding-agent.openAgent', async () => {
        await vscode.commands.executeCommand('workbench.view.extension.localCodingAgentSidebar');
        provider.reveal();
    });

    register('local-coding-agent.switchMode', async () => {
        const picked = await vscode.window.showQuickPick(
            [
                { label: 'Ask', description: 'Answer questions, read-only', value: 'ask' as AgentMode },
                { label: 'Agent', description: 'Edit files and run commands with approval', value: 'agent' as AgentMode }
            ],
            { title: 'Local Coding Agent mode' }
        );
        if (picked) {
            await provider.setMode(picked.value);
        }
    });

    // Change review commands (used by the editor CodeLens and the palette).
    register('localCodingAgent.approveChange', (id: string) => edits.approve(id));
    register('localCodingAgent.undoChange', (id: string) => provider.undoChange(id));
    register('localCodingAgent.showChangeDiff', (id: string) => edits.showDiff(id));
    register('localCodingAgent.approveAllChanges', () => edits.approveAll());
    register('localCodingAgent.undoAllChanges', () => edits.undoAll());

    register('local-coding-agent.listWorkspaceFiles', async () => {
        const document = await vscode.workspace.openTextDocument({ content: await listWorkspaceFiles(), language: 'text' });
        await vscode.window.showTextDocument(document);
    });

    register('local-coding-agent.readFile', async () => {

        const relativePath = await vscode.window.showInputBox({
            prompt: 'Enter a file path relative to the workspace root',
            placeHolder: 'src/index.ts'
        });
        if (!relativePath) {
            return;
        }

        try {
            const result = await readFile(relativePath);
            const document = await vscode.workspace.openTextDocument({ content: result.content });
            await vscode.window.showTextDocument(document);
            vscode.window.setStatusBarMessage(`Local Coding Agent: read ${result.sizeBytes} bytes from ${result.relativePath}`, 4000);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`Local Coding Agent: ${message}`);
        }
    });

    register('local-coding-agent.optimizeAndTest', () =>
        runOptimizeAndTest(provider.getOllamaUrl(), provider.getCurrentModel()));

    register('local-coding-agent.raisePR', () => runRaisePR());

    register('local-coding-agent.selectModel', async () => {

        const models = await fetchOllamaModels(provider.getOllamaUrl());
        if (!models || models.length === 0) {
            vscode.window.showWarningMessage(
                `Local Coding Agent: couldn't reach Ollama at ${provider.getOllamaUrl()} to list models. Is "ollama serve" running?`
            );
            return;
        }

        const picked = await vscode.window.showQuickPick(
            models.map(name => ({ label: name, description: name === provider.getCurrentModel() ? 'current' : undefined })),
            { title: 'Select the Ollama model for Local Coding Agent' }
        );

        if (picked) {
            await provider.setCurrentModel(picked.label);
            vscode.window.setStatusBarMessage(`Local Coding Agent: now using ${picked.label}`, 3000);
        }
    });

    if (vscode.workspace.workspaceFolders?.length) {
        vscode.commands.executeCommand('workbench.view.extension.localCodingAgentSidebar');
    }
}

export function deactivate() {}
