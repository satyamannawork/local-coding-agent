import * as vscode from 'vscode';
import { readFile } from '../tools/fileTools';
import { EditManager, PendingChange } from '../edits/editManager';
import { CommandResult } from '../terminal/commandRunner';

export type AgentMode = 'ask' | 'agent';

export const MAX_CONTEXT_CHARS = 20000;
const MAX_TOOL_OUTPUT = 12000;

export interface ToolContext {
	mode: AgentMode;
	edits: EditManager;
	signal: AbortSignal;
	/**
	 * Asks the developer in the chat to approve the command (they may edit it),
	 * then runs it. Resolves undefined if they rejected it.
	 */
	runCommandWithApproval(command: string): Promise<{ command: string; result: CommandResult } | undefined>;
	onChange(change: PendingChange): void;
}

function fn(name: string, description: string, properties: Record<string, unknown>, required: string[]) {
	return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } };
}

const READ_TOOLS = [
	fn('list_workspace_files',
		'Lists every file path in the current VS Code workspace (excluding node_modules, .git, dist, out). Use this to discover what a project contains.',
		{}, []),
	fn('read_file',
		'Reads the full text contents of one file, given a path relative to the workspace root.',
		{ path: { type: 'string', description: 'File path relative to the workspace root, e.g. "src/main/java/com/example/Foo.java".' } },
		['path']),
	fn('search_workspace',
		'Searches all workspace files for a plain-text string (case-insensitive) and returns matching lines as path:line: text.',
		{ query: { type: 'string', description: 'Text to search for, e.g. a class or function name.' } },
		['query'])
];

const WRITE_TOOLS = [
	fn('edit_file',
		'Edits an existing file by replacing one exact snippet with new code. Only the matched spot changes; the rest of the file is untouched. ' +
		'old_string must be copied exactly from the current file (include 2-3 surrounding lines so it is unique). ' +
		'For several separate changes, call edit_file several times. Never use this to rewrite a whole file.',
		{
			path: { type: 'string', description: 'File path relative to the workspace root.' },
			old_string: { type: 'string', description: 'The exact existing code to replace.' },
			new_string: { type: 'string', description: 'The code that replaces old_string.' }
		},
		['path', 'old_string', 'new_string']),
	fn('create_file',
		'Creates a NEW file with the given content. Fails if the file already exists (use edit_file instead). Parent folders are created automatically.',
		{
			path: { type: 'string', description: 'File path relative to the workspace root.' },
			content: { type: 'string', description: 'Full content of the new file.' }
		},
		['path', 'content']),
	fn('run_command',
		'Runs a shell command in the workspace root (e.g. installing dependencies, building, running tests, git status). ' +
		'The developer must approve it first. Returns the exit code and output. Avoid commands that never exit, such as dev servers or watchers.',
		{ command: { type: 'string', description: 'The shell command to run.' } },
		['command'])
];

export function buildToolDefinitions(mode: AgentMode) {
	return mode === 'agent' ? [...READ_TOOLS, ...WRITE_TOOLS] : READ_TOOLS;
}

function str(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	return typeof value === 'string' ? value : '';
}

function clip(text: string, limit = MAX_TOOL_OUTPUT): string {
	return text.length > limit ? text.slice(0, limit) + '\n[...truncated...]' : text;
}

export async function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<string> {

	try {

		const writeTool = ['edit_file', 'create_file', 'run_command'].includes(name);
		if (writeTool && ctx.mode !== 'agent') {
			return `Error: "${name}" is only available in Agent mode. Show the code in your answer instead.`;
		}

		switch (name) {

			case 'list_workspace_files':
				return await listWorkspaceFiles();

			case 'read_file': {
				const relativePath = str(args, 'path');
				if (!relativePath) {
					return 'Error: no "path" argument was provided.';
				}
				const result = await readFile(relativePath);
				// Prefer the editor buffer when open, so the model sees unsaved/agent edits.
				const open = vscode.workspace.textDocuments.find(d => vscode.workspace.asRelativePath(d.uri) === relativePath);
				const content = open ? open.getText() : result.content;
				return `File: ${result.relativePath}\n\n${clip(content, MAX_CONTEXT_CHARS)}`;
			}

			case 'search_workspace':
				return await searchWorkspace(str(args, 'query'));

			case 'edit_file': {
				const change = await ctx.edits.applySearchReplace(str(args, 'path'), str(args, 'old_string'), str(args, 'new_string'));
				ctx.onChange(change);
				return `Edited ${change.relativePath} at line ${change.firstLine + 1} (+${change.added} -${change.removed} lines). ` +
					'The change is applied and waiting for the developer to approve or undo it. Continue with the next step.';
			}

			case 'create_file': {
				const change = await ctx.edits.createFile(str(args, 'path'), str(args, 'content'));
				ctx.onChange(change);
				return `Created ${change.relativePath} (${change.added} lines). The developer can approve or reject it.`;
			}

			case 'run_command': {
				const proposed = str(args, 'command').trim();
				if (!proposed) {
					return 'Error: no "command" argument was provided.';
				}
				const outcome = await ctx.runCommandWithApproval(proposed);
				if (ctx.signal.aborted) {
					return 'The developer stopped the agent.';
				}
				if (!outcome) {
					return `The developer rejected the command "${proposed}". Do not retry it; ask or continue another way.`;
				}
				const { command: approved, result } = outcome;
				const status = result.timedOut ? 'timed out and was stopped'
					: result.cancelled ? 'was cancelled'
						: `exited with code ${result.exitCode}`;
				return `Command "${approved}" ${status}.\nOutput:\n${clip(result.output.trim() || '(no output)')}`;
			}

			default:
				return `Error: unknown tool "${name}".`;
		}

	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Error running tool "${name}": ${message}`;
	}
}

const EXCLUDE = '**/{node_modules,.git,dist,out,build,target,.next,.venv,venv}/**';

export async function listWorkspaceFiles(): Promise<string> {

	if (!vscode.workspace.workspaceFolders?.length) {
		return 'No workspace is currently open.';
	}

	const files = await vscode.workspace.findFiles('**/*', EXCLUDE, 500);

	if (files.length === 0) {
		return 'No files found in the current workspace.';
	}

	return files.map(file => vscode.workspace.asRelativePath(file)).sort().join('\n');
}

async function searchWorkspace(query: string): Promise<string> {

	if (!query.trim()) {
		return 'Error: no "query" argument was provided.';
	}

	const needle = query.toLowerCase();
	const files = await vscode.workspace.findFiles('**/*', EXCLUDE, 2000);
	const hits: string[] = [];

	for (const file of files) {
		if (hits.length >= 60) {
			break;
		}
		let text: string;
		try {
			const bytes = await vscode.workspace.fs.readFile(file);
			if (bytes.byteLength > 1_000_000 || bytes.includes(0)) {
				continue;
			}
			text = new TextDecoder('utf-8').decode(bytes);
		} catch {
			continue;
		}
		const lines = text.split(/\r?\n/);
		for (let i = 0; i < lines.length && hits.length < 60; i++) {
			if (lines[i].toLowerCase().includes(needle)) {
				hits.push(`${vscode.workspace.asRelativePath(file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
			}
		}
	}

	return hits.length ? hits.join('\n') : `No matches for "${query}".`;
}
