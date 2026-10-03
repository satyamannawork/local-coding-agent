// @ts-check
/* global acquireVsCodeApi */
(function () {

    const vscode = acquireVsCodeApi();
    const $ = (id) => /** @type {any} */ (document.getElementById(id));

    const messages = $('messages');
    const input = $('input');
    const send = $('send');
    const stop = $('stop');
    const status = $('status');
    const modelSelect = $('modelSelect');
    const modeSelect = $('modeSelect');
    const modeHint = $('modeHint');
    const refreshModels = $('refreshModels');
    const newChat = $('newChat');
    const includeContext = $('includeContext');
    const connDot = $('connDot');
    const connLabel = $('connLabel');
    const pendingBar = $('pendingBar');
    const pendingText = $('pendingText');

    let currentAssistantEl = null;
    let currentAssistantRaw = '';

    const MODE_HINTS = {
        ask: 'Ask: answers questions and reads your project. Use Apply on a code block to change a file.',
        agent: 'Agent: edits and creates files directly, and runs commands after you approve them.'
    };

    // ------------------------------------------------------------ helpers

    function b64encode(str) { return btoa(unescape(encodeURIComponent(str))); }
    function b64decode(str) { return decodeURIComponent(escape(atob(str))); }

    function esc(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function scrollDown() { messages.scrollTop = messages.scrollHeight; }

    function guessPathFromCode(code) {
        const firstLine = code.split('\n', 1)[0] || '';
        const match = firstLine.match(/(?:\/\/|#|<!--|--)\s*([\w./-]+\.[\w]+)/);
        return match ? match[1] : '';
    }

    function renderText(text) {
        // Collapse <think>...</think> reasoning (qwen3 & co.) into a details element.
        let html = '';
        const re = /<think>([\s\S]*?)(<\/think>|$)/g;
        let last = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            html += esc(text.slice(last, m.index));
            const body = m[1].trim();
            if (body) {
                html += '<details class="thinking"><summary>' + (m[2] ? 'Thought process' : 'Thinking…') +
                    '</summary><div>' + esc(body) + '</div></details>';
            }
            last = re.lastIndex;
            if (!m[2]) { break; }
        }
        const rest = text.slice(last);
        html += esc(last ? rest.replace(/^\s+/, '') : rest);
        return html;
    }

    function renderContent(raw) {

        const parts = raw.split(/```([\w+#.-]*)\n?([\s\S]*?)(?:```|$)/g);
        let html = '';

        for (let i = 0; i < parts.length; i += 3) {

            const text = parts[i] || '';
            if (text) { html += '<span>' + renderText(text) + '</span>'; }

            const lang = parts[i + 1];
            const code = parts[i + 2];

            if (code !== undefined) {
                const encoded = b64encode(code);
                html += '<div class="code-block">' +
                    '<div class="code-block-header">' +
                        '<span class="code-block-lang">' + esc(lang || 'code') + '</span>' +
                        '<div class="code-block-actions">' +
                            '<button data-action="copy" data-code="' + encoded + '">Copy</button>' +
                            '<button class="primary" data-action="apply" data-code="' + encoded + '" data-path="' + esc(guessPathFromCode(code)) + '" title="Apply only the changed lines to a file, then approve or undo">Apply</button>' +
                        '</div>' +
                    '</div>' +
                    '<pre><code>' + esc(code) + '</code></pre>' +
                '</div>';
            }
        }

        return html;
    }

    function addMessage(type, text) {

        const message = document.createElement('div');
        message.className = 'message ' + type;

        const label = document.createElement('div');
        label.className = 'label';
        const avatar = document.createElement('span');
        avatar.className = 'avatar';
        avatar.textContent = type === 'user' ? 'You' : 'AI';
        label.appendChild(avatar);
        label.appendChild(document.createTextNode(type === 'user' ? 'You' : (modelSelect.value || 'Assistant')));

        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        if (type === 'user') { bubble.textContent = text; } else { bubble.innerHTML = renderContent(text); }

        message.appendChild(label);
        message.appendChild(bubble);
        messages.appendChild(message);
        scrollDown();
        return { message, bubble };
    }

    function addNote(text, className) {
        const note = document.createElement('div');
        note.className = 'context-badge ' + (className || '');
        note.textContent = text;
        messages.appendChild(note);
        scrollDown();
    }

    function toolLabel(name, args) {
        args = args || {};
        switch (name) {
            case 'read_file': return '📖 Reading ' + (args.path || 'file');
            case 'list_workspace_files': return '📂 Listing workspace files';
            case 'search_workspace': return '🔎 Searching for "' + (args.query || '') + '"';
            case 'edit_file': return '✏️ Editing ' + (args.path || 'file');
            case 'create_file': return '📄 Creating ' + (args.path || 'file');
            case 'run_command': return '⌨️ Wants to run a command';
            default: return '🔧 ' + name;
        }
    }

    // ------------------------------------------------------- change cards

    const STATUS_TEXT = { pending: 'Pending review', approved: 'Approved', undone: 'Undone' };

    function renderChangeCard(card, change) {

        const isCreate = change.kind === 'create';
        const statusText = change.status === 'undone' && isCreate ? 'Rejected' : STATUS_TEXT[change.status];
        const icon = isCreate ? '📄' : '✏️';
        const stats = '<span class="stat-add">+' + change.added + '</span> <span class="stat-del">−' + change.removed + '</span>';

        let actions = '';
        if (change.status === 'pending') {
            actions = '<div class="card-actions">' +
                '<button class="btn primary" data-change="approve">✓ Approve</button>' +
                '<button class="btn danger" data-change="undo">' + (isCreate ? '✕ Reject' : '↺ Undo') + '</button>' +
                '<button class="btn link" data-change="diff">View diff</button>' +
            '</div>';
        }

        card.innerHTML =
            '<div class="card-head">' +
                '<span class="card-icon">' + icon + '</span>' +
                '<span class="card-title"><a data-change="reveal" title="Open in editor">' + esc(change.relativePath) + '</a>' +
                    '<span class="card-sub">' + (isCreate ? 'new file · ' : 'line ' + (change.firstLine + 1) + ' · ') + stats + '</span></span>' +
                '<span class="card-status ' + change.status + '">' + statusText + '</span>' +
            '</div>' + actions;
    }

    function upsertChange(change) {
        let card = messages.querySelector('.card[data-id="' + change.id + '"]');
        if (!card) {
            card = document.createElement('div');
            card.className = 'card change-card';
            card.setAttribute('data-id', change.id);
            messages.appendChild(card);
            scrollDown();
        }
        renderChangeCard(card, change);
    }

    // ------------------------------------------------------ command cards

    function addCommandCard(id, command) {
        const card = document.createElement('div');
        card.className = 'card cmd-card';
        card.setAttribute('data-id', id);
        card.innerHTML =
            '<div class="card-head"><span class="card-icon">⌨️</span>' +
                '<span class="card-title">Run this command?</span>' +
                '<span class="card-status pending">Needs approval</span></div>' +
            '<textarea class="cmd" spellcheck="false" title="You can edit the command before running it"></textarea>' +
            '<div class="card-actions">' +
                '<button class="btn primary" data-cmd="run">▶ Run</button>' +
                '<button class="btn danger" data-cmd="reject">✕ Reject</button>' +
            '</div>';
        card.querySelector('textarea').value = command;
        messages.appendChild(card);
        scrollDown();
    }

    function setCommandState(id, label, cls, command, output) {
        const card = messages.querySelector('.cmd-card[data-id="' + id + '"]');
        if (!card) { return; }
        let html = '<div class="card-head"><span class="card-icon">⌨️</span>' +
            '<span class="card-title"><code>' + esc(command) + '</code></span>' +
            '<span class="card-status ' + cls + '">' + esc(label) + '</span></div>';
        if (output !== undefined) {
            html += '<pre class="cmd-output">' + esc(output || '(no output)') + '</pre>';
        }
        card.innerHTML = html;
        card.setAttribute('data-command', command);
        scrollDown();
    }

    // ------------------------------------------------------------ events

    messages.addEventListener('click', (event) => {

        const target = /** @type {HTMLElement} */ (event.target);

        const codeBtn = target.closest('button[data-action]');
        if (codeBtn) {
            const code = b64decode(codeBtn.getAttribute('data-code'));
            if (codeBtn.getAttribute('data-action') === 'copy') {
                navigator.clipboard && navigator.clipboard.writeText(code);
                const original = codeBtn.textContent;
                codeBtn.textContent = 'Copied!';
                setTimeout(() => { codeBtn.textContent = original; }, 1200);
            } else {
                vscode.postMessage({ type: 'applyCode', code, suggestedPath: codeBtn.getAttribute('data-path') || '' });
            }
            return;
        }

        const changeEl = target.closest('[data-change]');
        if (changeEl) {
            const card = changeEl.closest('.change-card');
            const id = card && card.getAttribute('data-id');
            const action = changeEl.getAttribute('data-change');
            const type = { approve: 'approveChange', undo: 'undoChange', diff: 'showDiff', reveal: 'revealChange' }[action];
            if (id && type) {
                if (action === 'approve' || action === 'undo') {
                    card.querySelectorAll('button').forEach(b => { b.disabled = true; });
                }
                vscode.postMessage({ type, id });
            }
            return;
        }

        const cmdBtn = target.closest('button[data-cmd]');
        if (cmdBtn) {
            const card = cmdBtn.closest('.cmd-card');
            const id = card.getAttribute('data-id');
            const command = card.querySelector('textarea').value.trim();
            const approved = cmdBtn.getAttribute('data-cmd') === 'run' && command.length > 0;
            setCommandState(id, approved ? 'Running…' : 'Rejected', approved ? 'pending' : 'undone', command);
            vscode.postMessage({ type: 'commandDecision', id, approved, command });
        }
    });

    $('approveAll').addEventListener('click', () => vscode.postMessage({ type: 'approveAll' }));
    $('undoAll').addEventListener('click', () => vscode.postMessage({ type: 'undoAll' }));

    function setBusy(busy) {
        send.disabled = busy;
        stop.classList.toggle('visible', busy);
        status.classList.toggle('typing', busy);
    }

    function sendMessage() {
        const text = input.value.trim();
        if (!text || send.disabled) { return; }
        addMessage('user', text);
        input.value = '';
        setBusy(true);
        currentAssistantEl = null;
        currentAssistantRaw = '';
        vscode.postMessage({ type: 'sendMessage', text, includeContext: includeContext.checked });
    }

    send.addEventListener('click', sendMessage);
    stop.addEventListener('click', () => vscode.postMessage({ type: 'stopGeneration' }));

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    });

    function applyMode(mode) {
        modeSelect.value = mode;
        modeHint.textContent = MODE_HINTS[mode] || '';
        input.placeholder = mode === 'agent'
            ? 'Tell the agent what to build or change... (Enter to send)'
            : 'Ask about your code... (Enter to send, Shift+Enter for a new line)';
    }

    modeSelect.addEventListener('change', () => {
        applyMode(modeSelect.value);
        vscode.postMessage({ type: 'setMode', mode: modeSelect.value });
    });

    modelSelect.addEventListener('change', () => vscode.postMessage({ type: 'setModel', model: modelSelect.value }));

    refreshModels.addEventListener('click', () => {
        connLabel.textContent = 'checking';
        vscode.postMessage({ type: 'refreshModels' });
    });

    newChat.addEventListener('click', () => {
        vscode.postMessage({ type: 'newChat' });
        messages.innerHTML = '';
        addMessage('assistant', 'Started a new chat. Previous conversation memory has been cleared.');
        status.textContent = '';
    });

    function populateModels(models, currentModel) {
        const previousValue = modelSelect.value || currentModel;
        modelSelect.innerHTML = '';
        const list = models && models.length ? models : [previousValue].filter(Boolean);
        for (const name of list) {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            modelSelect.appendChild(option);
        }
        const toSelect = list.includes(currentModel) ? currentModel : (list.includes(previousValue) ? previousValue : list[0]);
        if (toSelect) { modelSelect.value = toSelect; }
    }

    window.addEventListener('message', (event) => {

        const message = event.data;

        switch (message.type) {

            case 'modelList':
                populateModels(message.models, message.currentModel);
                connDot.className = 'conn-dot ' + (message.connected ? 'online' : 'offline');
                connLabel.textContent = message.connected ? 'Ollama connected' : 'Ollama offline';
                break;

            case 'modelChanged':
                if (modelSelect.value !== message.model) { modelSelect.value = message.model; }
                break;

            case 'modeChanged':
                applyMode(message.mode);
                break;

            case 'contextAttached':
                addNote('📎 ' + message.relativePath + (message.truncated ? ' (truncated)' : ''));
                break;

            case 'toolCall':
                addNote(toolLabel(message.name, message.args), 'tool-call');
                break;

            case 'status':
                status.textContent = message.text;
                break;

            case 'startResponse': {
                status.textContent = '';
                const created = addMessage('assistant', '');
                currentAssistantEl = created.bubble;
                currentAssistantRaw = '';
                break;
            }

            case 'token':
                if (currentAssistantEl) {
                    currentAssistantRaw += message.text;
                    currentAssistantEl.innerHTML = renderContent(currentAssistantRaw);
                    scrollDown();
                }
                break;

            case 'endResponse':
                // Drop empty bubbles left by hops that only called tools.
                if (currentAssistantEl && !currentAssistantRaw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim()) {
                    const wrapper = currentAssistantEl.closest('.message');
                    if (currentAssistantRaw.trim()) {
                        wrapper.querySelector('.label').style.display = 'none';
                    } else {
                        wrapper.remove();
                    }
                }
                currentAssistantEl = null;
                break;

            case 'complete':
                setBusy(false);
                status.textContent = message.stopped ? 'Stopped.' : '';
                input.focus();
                break;

            case 'error':
                setBusy(false);
                status.textContent = 'Error';
                addMessage('assistant', 'Error: ' + message.text);
                break;

            case 'change':
                upsertChange(message.change);
                break;

            case 'pendingCount':
                pendingBar.classList.toggle('visible', message.count > 0);
                pendingText.textContent = message.count + (message.count === 1 ? ' change' : ' changes') +
                    ' waiting for review';
                break;

            case 'commandApproval':
                addCommandCard(message.id, message.command);
                break;

            case 'commandResult': {
                const label = message.timedOut ? 'Timed out' : message.cancelled ? 'Cancelled'
                    : message.exitCode === 0 ? 'Exit 0' : 'Exit ' + message.exitCode;
                setCommandState(message.id, label, message.exitCode === 0 ? 'approved' : 'undone', message.command, message.output);
                break;
            }

            case 'commandCancelled':
                setCommandState(message.id, 'Cancelled', 'undone', message.command);
                break;

            case 'notice':
                addNote((message.ok ? '✓ ' : '✕ ') + message.text, 'apply-result ' + (message.ok ? 'ok' : 'fail'));
                break;
        }
    });

    applyMode(modeSelect.value);
    vscode.postMessage({ type: 'ready' });
})();
