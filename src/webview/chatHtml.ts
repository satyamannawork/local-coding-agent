import * as vscode from 'vscode';
import { AgentMode } from '../agent/tools';

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#039;');
}

function nonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) {
		out += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return out;
}

export function getWebviewContent(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	model: string,
	mode: AgentMode,
	includeContextByDefault: boolean
): string {

	const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.css'));
	const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'chat.js'));
	const n = nonce();
	const m = escapeHtml(model);

	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Local Coding Agent</title>
<link rel="stylesheet" href="${cssUri}">
</head>
<body>

<div class="header">
    <div class="header-top">
        <div class="brand">
            <svg class="brand-icon" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M4 5C4 3.89543 4.89543 3 6 3H18C19.1046 3 20 3.89543 20 5V14C20 15.1046 19.1046 16 18 16H13L8 20V16H6C4.89543 16 4 15.1046 4 14V5Z" fill="currentColor"/>
                <circle cx="8.5" cy="9.5" r="1.15" fill="var(--vscode-editor-background)"/>
                <circle cx="12" cy="9.5" r="1.15" fill="var(--vscode-editor-background)"/>
                <circle cx="15.5" cy="9.5" r="1.15" fill="var(--vscode-editor-background)"/>
            </svg>
            <div class="title">Local Coding Agent</div>
        </div>
        <div class="header-controls">
            <span class="conn-dot" id="connDot" title="Connecting to Ollama..."></span>
            <span class="conn-label" id="connLabel">checking</span>
        </div>
    </div>
    <div class="header-controls">
        <select id="modelSelect" title="Model used for chat and file operations">
            <option value="${m}">${m}</option>
        </select>
        <button class="icon-btn" id="refreshModels" title="Refresh model list from Ollama">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.65 2.35a7 7 0 1 0 1.94 6.15h-1.53a5.5 5.5 0 1 1-1.4-5.31L10.5 5.35H15V0.85l-1.35 1.5z"/></svg>
        </button>
        <button class="icon-btn" id="newChat" title="Start a new chat (clears conversation memory)">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 2h9v2H2V2zm0 5h12v2H2V7zm0 5h7v2H2v-2zM13.5 9.5v2h2v1.5h-2v2H12v-2h-2v-1.5h2v-2h1.5z"/></svg>
        </button>
    </div>
</div>

<div id="messages">
    <div class="message assistant">
        <div class="label"><span class="avatar">AI</span> Local Coding Agent</div>
        <div class="bubble">Model: ${m}

Ask mode answers questions about your code. Agent mode edits files in place and runs commands. You approve or undo every change.</div>
    </div>
</div>

<div class="status" id="status"></div>

<div class="pending-bar" id="pendingBar">
    <span id="pendingText"></span>
    <span class="btns">
        <button class="btn primary" id="approveAll">✓ Approve all</button>
        <button class="btn danger" id="undoAll">↺ Undo all</button>
    </span>
</div>

<div class="toolbar-row">
    <div class="toolbar-left">
        <select id="modeSelect" title="Ask answers questions. Agent edits files and runs commands with your approval.">
            <option value="ask"${mode === 'ask' ? ' selected' : ''}>Ask</option>
            <option value="agent"${mode === 'agent' ? ' selected' : ''}>Agent</option>
        </select>
        <label class="context-toggle" title="Attach the currently open file to your next message">
            <input type="checkbox" id="includeContext" ${includeContextByDefault ? 'checked' : ''}>
            Attach active file
        </label>
    </div>
</div>
<div class="mode-hint" id="modeHint"></div>

<div class="input-area">
    <textarea id="input" placeholder="Ask about your code... (Enter to send, Shift+Enter for a new line)"></textarea>
    <div class="send-stack">
        <button class="action" id="send">Send</button>
        <button class="action stop" id="stop">Stop</button>
    </div>
</div>

<script nonce="${n}" src="${jsUri}"></script>
</body>
</html>`;
}
