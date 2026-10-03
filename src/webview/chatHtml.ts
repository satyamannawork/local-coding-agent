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

<header class="header">
    <div class="brand">
        <span class="brand-mark">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 2.5l2.2 5.6 5.8 1.2-4.5 3.9 1.3 5.8L12 16l-4.8 3 1.3-5.8L4 9.3l5.8-1.2L12 2.5z" fill="currentColor"/></svg>
        </span>
        <div class="brand-text">
            <div class="title">Local Coding Agent</div>
            <div class="conn" id="conn" title="Connecting to Ollama...">
                <span class="conn-dot" id="connDot"></span>
                <span class="conn-label" id="connLabel">checking Ollama</span>
            </div>
        </div>
    </div>
    <div class="header-actions">
        <button class="icon-btn" id="refreshModels" title="Refresh model list from Ollama">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M13.65 2.35a7 7 0 1 0 1.94 6.15h-1.53a5.5 5.5 0 1 1-1.4-5.31L10.5 5.35H15V0.85l-1.35 1.5z"/></svg>
        </button>
        <button class="icon-btn" id="newChat" title="New chat (clears conversation memory)">
            <svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25V2z"/></svg>
        </button>
    </div>
</header>

<main id="messages">
    <section class="welcome" id="welcome">
        <div class="welcome-mark">
            <svg viewBox="0 0 24 24" fill="none"><path d="M12 2.5l2.2 5.6 5.8 1.2-4.5 3.9 1.3 5.8L12 16l-4.8 3 1.3-5.8L4 9.3l5.8-1.2L12 2.5z" fill="currentColor"/></svg>
        </div>
        <h2>What are we building?</h2>
        <p>Running <strong id="welcomeModel">${m}</strong> on your machine. Nothing leaves your computer.</p>
        <p class="muted"><b>Ask</b> explains and reads your code. <b>Agent</b> edits files and runs commands, and you approve every change.</p>
        <div class="suggestions">
            <button class="chip" data-suggest="Explain what the open file does.">Explain this file</button>
            <button class="chip" data-suggest="Review the open file and point out bugs or risky code.">Find bugs</button>
            <button class="chip" data-suggest="Write unit tests for the open file.">Write tests</button>
        </div>
    </section>
</main>

<div class="status" id="status">
    <span class="loader"><i></i><i></i><i></i></span>
    <span id="statusText"></span>
    <span class="elapsed" id="elapsed"></span>
</div>

<div class="pending-bar" id="pendingBar">
    <span id="pendingText"></span>
    <span class="btns">
        <button class="btn primary" id="approveAll">✓ Approve all</button>
        <button class="btn danger" id="undoAll">↺ Undo all</button>
    </span>
</div>

<footer class="composer-wrap">
    <div class="composer" id="composer">
        <textarea id="input" rows="1" placeholder="Ask about your code..."></textarea>
        <div class="composer-row">
            <div class="segmented" id="modeSwitch" role="tablist" title="Ask answers questions. Agent edits files and runs commands with your approval.">
                <button data-mode="ask" class="${mode === 'ask' ? 'active' : ''}">Ask</button>
                <button data-mode="agent" class="${mode === 'agent' ? 'active' : ''}">Agent</button>
            </div>
            <button class="toggle" id="thinkToggle" aria-pressed="false" title="Let the model think before answering. Smarter, but much slower.">
                <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a4.5 4.5 0 0 0-2.6 8.17V11.5c0 .28.22.5.5.5h4.2a.5.5 0 0 0 .5-.5V9.67A4.5 4.5 0 0 0 8 1.5zM6 13h4v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-1z"/></svg>
                Think
            </button>
            <button class="toggle" id="attachToggle" aria-pressed="${includeContextByDefault ? 'true' : 'false'}" title="Attach the currently open file to your message">
                <svg viewBox="0 0 16 16" fill="currentColor"><path d="M10.6 2.3a2.6 2.6 0 0 1 3.7 3.7L8 12.3a4 4 0 0 1-5.7-5.7l5.2-5.2 1 1-5.2 5.2a2.6 2.6 0 0 0 3.7 3.7L13.3 5a1.2 1.2 0 0 0-1.7-1.7L6.4 8.5a.1.1 0 0 0 .1.1l4.2-4.2 1 1-4.2 4.2a1.5 1.5 0 0 1-2.1-2.1l5.2-5.2z"/></svg>
                File
            </button>
            <span class="spacer"></span>
            <select id="modelSelect" title="Ollama model">
                <option value="${m}">${m}</option>
            </select>
            <button class="send" id="send" title="Send (Enter)">
                <svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 2.5l5 5-1.06 1.06L8.75 5.37V13.5h-1.5V5.37L4.06 8.56 3 7.5l5-5z"/></svg>
            </button>
            <button class="send stop" id="stop" title="Stop">
                <svg viewBox="0 0 16 16" fill="currentColor"><rect x="4" y="4" width="8" height="8" rx="1.5"/></svg>
            </button>
        </div>
    </div>
    <div class="mode-hint" id="modeHint"></div>
</footer>

<script nonce="${n}" src="${jsUri}"></script>
</body>
</html>`;
}
