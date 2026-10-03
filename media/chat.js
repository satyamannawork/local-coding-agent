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
    const statusText = $('statusText');
    const elapsedEl = $('elapsed');
    const modelSelect = $('modelSelect');
    const modeSwitch = $('modeSwitch');
    const modeHint = $('modeHint');
    const refreshModels = $('refreshModels');
    const newChat = $('newChat');
    const thinkToggle = $('thinkToggle');
    const attachToggle = $('attachToggle');
    const conn = $('conn');
    const connDot = $('connDot');
    const connLabel = $('connLabel');
    const pendingBar = $('pendingBar');
    const pendingText = $('pendingText');
    const welcomeTemplate = $('welcome').outerHTML;

    let mode = modeSwitch.querySelector('button.active')?.getAttribute('data-mode') || 'ask';
    let busy = false;
    let busySince = 0;
    let busyTimer = 0;

    /**
     * The assistant reply currently streaming in. Created lazily on the first
     * thinking or answer token, so tool-only steps never leave empty bubbles.
     * @type {null | {el: HTMLElement, bubble: HTMLElement | null, raw: string,
     *   think: HTMLDetailsElement | null, thinkBody: HTMLElement | null,
     *   thinkTime: HTMLElement | null, thinkStart: number, thinkTimer: number, renderQueued: boolean}}
     */
    let turn = null;

    const MODE_HINTS = {
        ask: 'Ask mode reads your project and answers. Use Apply on a code block to change a file.',
        agent: 'Agent mode edits files and runs commands. You approve every change.'
    };

    const SPARK = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2.5l2.2 5.6 5.8 1.2-4.5 3.9 1.3 5.8L12 16l-4.8 3 1.3-5.8L4 9.3l5.8-1.2L12 2.5z" fill="currentColor"/></svg>';
    const BULB = '<svg class="t-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5a4.5 4.5 0 0 0-2.6 8.17V11.5c0 .28.22.5.5.5h4.2a.5.5 0 0 0 .5-.5V9.67A4.5 4.5 0 0 0 8 1.5zM6 13h4v1a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-1z"/></svg>';

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

    function nearBottom() {
        return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 80;
    }

    /** Scrolls down only if the user hasn't scrolled up to read something. */
    function follow(wasNearBottom) {
        if (wasNearBottom) { messages.scrollTop = messages.scrollHeight; }
    }

    function formatSeconds(ms) {
        const s = Math.max(0, Math.round(ms / 1000));
        return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    }

    function guessPathFromCode(code) {
        const firstLine = code.split('\n', 1)[0] || '';
        const match = firstLine.match(/(?:\/\/|#|<!--|--)\s*([\w./-]+\.[\w]+)/);
        return match ? match[1] : '';
    }

    function removeWelcome() {
        const welcome = $('welcome');
        if (welcome) { welcome.remove(); }
    }

    // ----------------------------------------------------------- markdown

    function inline(text) {
        // text is already HTML-escaped
        return text
            .replace(/`([^`\n]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
            .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
            .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>')
            .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
    }

    /** Small, safe markdown renderer for prose (code fences are handled separately). */
    function markdown(text) {
        const lines = esc(text).split('\n');
        let html = '';
        let para = [];
        let list = null; // 'ul' | 'ol'

        const flushPara = () => {
            if (para.length) { html += '<p>' + para.map(inline).join('<br>') + '</p>'; para = []; }
        };
        const closeList = () => {
            if (list) { html += '</' + list + '>'; list = null; }
        };

        for (const line of lines) {
            let m;
            if (!line.trim()) { flushPara(); closeList(); continue; }
            if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/))) {
                flushPara(); closeList();
                const level = Math.min(5, m[1].length + 2);
                html += '<h' + level + '>' + inline(m[2]) + '</h' + level + '>';
                continue;
            }
            if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushPara(); closeList(); html += '<hr>'; continue; }
            if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
                flushPara();
                if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
                html += '<li>' + inline(m[1]) + '</li>';
                continue;
            }
            if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
                flushPara();
                if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
                html += '<li>' + inline(m[1]) + '</li>';
                continue;
            }
            if ((m = line.match(/^\s*&gt;\s?(.*)$/))) {
                flushPara(); closeList();
                html += '<blockquote>' + inline(m[1]) + '</blockquote>';
                continue;
            }
            closeList();
            para.push(line);
        }
        flushPara(); closeList();
        return html;
    }

    function renderText(text) {
        // Older Ollama versions put qwen3 reasoning inline as <think>...</think>.
        let html = '';
        const re = /<think>([\s\S]*?)(<\/think>|$)/g;
        let last = 0;
        let m;
        while ((m = re.exec(text)) !== null) {
            html += markdown(text.slice(last, m.index));
            const body = m[1].trim();
            if (body) {
                html += '<details class="thinking' + (m[2] ? '' : ' live') + '"' + (m[2] ? '' : ' open') + '><summary>' + BULB +
                    '<span class="t-label">' + (m[2] ? 'Thought process' : 'Thinking') + '</span></summary>' +
                    '<div class="thinking-body">' + esc(body) + '</div></details>';
            }
            last = re.lastIndex;
            if (!m[2]) { break; }
        }
        html += markdown(text.slice(last));
        return html;
    }

    function renderContent(raw) {

        const parts = raw.split(/```([\w+#.-]*)\n?([\s\S]*?)(?:```|$)/g);
        let html = '';

        for (let i = 0; i < parts.length; i += 3) {

            const text = parts[i] || '';
            if (text.trim()) { html += renderText(text); }

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

    // ----------------------------------------------------------- messages

    function createMessage(type) {
        removeWelcome();
        const message = document.createElement('div');
        message.className = 'message ' + type;
        const label = document.createElement('div');
        label.className = 'label';
        label.innerHTML = type === 'user'
            ? '<span class="avatar">You</span>You'
            : '<span class="avatar">' + SPARK + '</span>' + esc(modelSelect.value || 'Assistant');
        message.appendChild(label);
        messages.appendChild(message);
        return message;
    }

    function addUserMessage(text) {
        const stick = true;
        const message = createMessage('user');
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.textContent = text;
        message.appendChild(bubble);
        follow(stick);
    }

    function addAssistantText(text) {
        const message = createMessage('assistant');
        const bubble = document.createElement('div');
        bubble.className = 'bubble';
        bubble.innerHTML = renderContent(text);
        message.appendChild(bubble);
        follow(true);
    }

    function addNote(text, className) {
        const stick = nearBottom();
        removeWelcome();
        const note = document.createElement('div');
        note.className = 'note ' + (className || '');
        note.textContent = text;
        note.title = text;
        messages.appendChild(note);
        follow(stick);
    }

    const ERROR_HINTS = [
        { re: /repeat limit|repetition/i, title: 'The model got stuck repeating itself',
            hint: 'This happens with long reasoning or a very full context. Ask again, rephrase, or start a new chat. Turning Think off also helps.' },
        { re: /fetch failed|ECONNREFUSED|ENOTFOUND|network/i, title: "Can't reach Ollama",
            hint: 'Make sure Ollama is running (ollama serve) and the URL in settings is correct.' },
        { re: /not found|pull/i, title: 'Model not available',
            hint: 'Pull it first with "ollama pull <model>", or pick another model below.' },
        { re: /memory|out of memory|OOM/i, title: 'Not enough memory',
            hint: 'Lower "Context Length" in settings or choose a smaller model.' }
    ];

    function addError(text) {
        removeWelcome();
        const known = ERROR_HINTS.find(e => e.re.test(text));
        const card = document.createElement('div');
        card.className = 'error-card';
        card.innerHTML = '<span class="e-icon">!</span><div>' +
            '<div class="e-title">' + esc(known ? known.title : 'Something went wrong') + '</div>' +
            (known ? '<div class="e-hint">' + esc(known.hint) + '</div>' : '') +
            '<div class="e-raw">' + esc(text) + '</div></div>';
        messages.appendChild(card);
        follow(true);
    }

    function toolLabel(name, args) {
        args = args || {};
        switch (name) {
            case 'read_file': return '📖  Reading ' + (args.path || 'file');
            case 'list_workspace_files': return '📂  Listing workspace files';
            case 'search_workspace': return '🔎  Searching for "' + (args.query || '') + '"';
            case 'edit_file': return '✏️  Editing ' + (args.path || 'file');
            case 'create_file': return '📄  Creating ' + (args.path || 'file');
            case 'run_command': return '⌨️  Wants to run a command';
            default: return '🔧  ' + name;
        }
    }

    // ------------------------------------------------------ streaming turn

    function ensureTurn() {
        if (!turn) {
            turn = { el: createMessage('assistant'), bubble: null, raw: '', think: null, thinkBody: null,
                thinkTime: null, thinkStart: 0, thinkTimer: 0, renderQueued: false };
        }
        return turn;
    }

    function addThinking(text) {
        const stick = nearBottom();
        const t = ensureTurn();
        if (!t.think) {
            const details = document.createElement('details');
            details.className = 'thinking live';
            details.open = true;
            details.innerHTML = '<summary>' + BULB + '<span class="t-label">Thinking</span><span class="t-time">0s</span></summary>' +
                '<div class="thinking-body"></div>';
            t.el.insertBefore(details, t.bubble);
            t.think = /** @type {HTMLDetailsElement} */ (details);
            t.thinkBody = details.querySelector('.thinking-body');
            t.thinkTime = details.querySelector('.t-time');
            t.thinkStart = Date.now();
            t.thinkTimer = window.setInterval(() => {
                if (t.thinkTime) { t.thinkTime.textContent = formatSeconds(Date.now() - t.thinkStart); }
            }, 500);
            setStatus('Thinking…');
        }
        if (t.thinkBody) {
            t.thinkBody.textContent += text;
            t.thinkBody.scrollTop = t.thinkBody.scrollHeight;
        }
        follow(stick);
    }

    function closeThinking(t) {
        if (!t.think || !t.think.classList.contains('live')) { return; }
        window.clearInterval(t.thinkTimer);
        t.think.classList.remove('live');
        t.think.open = false;
        const label = t.think.querySelector('.t-label');
        if (label) { label.textContent = 'Thought for ' + formatSeconds(Date.now() - t.thinkStart); }
        if (t.thinkTime) { t.thinkTime.textContent = ''; }
    }

    function addToken(text) {
        const t = ensureTurn();
        closeThinking(t);
        if (!t.bubble) {
            t.bubble = document.createElement('div');
            t.bubble.className = 'bubble cursor';
            t.el.appendChild(t.bubble);
            setStatus('Writing…');
        }
        t.raw += text;
        if (!t.renderQueued) {
            t.renderQueued = true;
            requestAnimationFrame(() => {
                if (!t.bubble) { return; }
                t.renderQueued = false;
                const stick = nearBottom();
                t.bubble.innerHTML = renderContent(t.raw);
                follow(stick);
            });
        }
    }

    function finishTurn(stats) {
        const t = turn;
        turn = null;
        if (!t) { return; }
        closeThinking(t);
        const visible = t.raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
        if (t.bubble) {
            t.bubble.classList.remove('cursor');
            if (visible) {
                t.bubble.innerHTML = renderContent(t.raw);
            } else {
                t.bubble.remove();
                t.bubble = null;
            }
        }
        if (!t.bubble && !t.think) {
            t.el.remove();
            return;
        }
        if (!t.bubble) {
            // Thinking-only step (the model went on to call tools): keep it small.
            t.el.classList.add('compact');
            return;
        }
        if (stats && stats.outputTokens) {
            const meta = document.createElement('div');
            meta.className = 'meta';
            meta.textContent = stats.outputTokens + ' tokens · ' +
                stats.tokensPerSecond.toFixed(1) + ' tok/s · ' + stats.totalSeconds.toFixed(1) + 's';
            meta.title = 'Prompt: ' + stats.promptTokens + ' tokens';
            t.el.appendChild(meta);
        }
    }

    // ------------------------------------------------------- change cards

    const STATUS_TEXT = { pending: 'Pending review', approved: 'Approved', undone: 'Undone' };

    function renderChangeCard(card, change) {

        const isCreate = change.kind === 'create';
        const statusLabel = change.status === 'undone' && isCreate ? 'Rejected' : STATUS_TEXT[change.status];
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
                '<span class="card-status ' + change.status + '">' + statusLabel + '</span>' +
            '</div>' + actions;
    }

    function upsertChange(change) {
        let card = messages.querySelector('.card[data-id="' + change.id + '"]');
        if (!card) {
            removeWelcome();
            card = document.createElement('div');
            card.className = 'card change-card';
            card.setAttribute('data-id', change.id);
            messages.appendChild(card);
            follow(true);
        }
        renderChangeCard(card, change);
    }

    // ------------------------------------------------------ command cards

    function addCommandCard(id, command) {
        removeWelcome();
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
        follow(true);
    }

    function setCommandState(id, label, cls, command, output) {
        const card = messages.querySelector('.cmd-card[data-id="' + id + '"]');
        if (!card) { return; }
        const stick = nearBottom();
        let html = '<div class="card-head"><span class="card-icon">⌨️</span>' +
            '<span class="card-title"><code>' + esc(command) + '</code></span>' +
            '<span class="card-status ' + cls + '">' + esc(label) + '</span></div>';
        if (output !== undefined) {
            html += '<pre class="cmd-output">' + esc(output || '(no output)') + '</pre>';
        }
        card.innerHTML = html;
        card.setAttribute('data-command', command);
        follow(stick);
    }

    // ------------------------------------------------------------- status

    function setStatus(text) {
        statusText.textContent = text;
    }

    function setBusy(value) {
        busy = value;
        send.classList.toggle('hidden', value);
        stop.classList.toggle('visible', value);
        status.classList.toggle('visible', value);
        window.clearInterval(busyTimer);
        if (value) {
            busySince = Date.now();
            elapsedEl.textContent = '0s';
            busyTimer = window.setInterval(() => { elapsedEl.textContent = formatSeconds(Date.now() - busySince); }, 500);
        } else {
            elapsedEl.textContent = '';
        }
        updateSendState();
    }

    function updateSendState() {
        send.disabled = busy || !input.value.trim();
    }

    // ------------------------------------------------------------ events

    messages.addEventListener('click', (event) => {

        const target = /** @type {HTMLElement} */ (event.target);

        const chip = target.closest('[data-suggest]');
        if (chip) {
            input.value = chip.getAttribute('data-suggest');
            autoGrow();
            updateSendState();
            input.focus();
            return;
        }

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

    function autoGrow() {
        input.style.height = 'auto';
        input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    }

    function sendMessage() {
        const text = input.value.trim();
        if (!text || busy) { return; }
        addUserMessage(text);
        input.value = '';
        autoGrow();
        turn = null;
        setBusy(true);
        setStatus((modelSelect.value || 'Model') + ' is reading your request…');
        vscode.postMessage({ type: 'sendMessage', text, includeContext: attachToggle.getAttribute('aria-pressed') === 'true' });
    }

    send.addEventListener('click', sendMessage);
    stop.addEventListener('click', () => vscode.postMessage({ type: 'stopGeneration' }));

    input.addEventListener('input', () => { autoGrow(); updateSendState(); });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            sendMessage();
        }
    });

    function applyMode(value) {
        mode = value === 'agent' ? 'agent' : 'ask';
        modeSwitch.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.getAttribute('data-mode') === mode));
        modeHint.textContent = MODE_HINTS[mode];
        input.placeholder = mode === 'agent'
            ? 'Tell the agent what to build or change…'
            : 'Ask about your code…  (Shift+Enter for a new line)';
    }

    modeSwitch.addEventListener('click', (event) => {
        const btn = /** @type {HTMLElement} */ (event.target).closest('button[data-mode]');
        if (!btn) { return; }
        applyMode(btn.getAttribute('data-mode'));
        vscode.postMessage({ type: 'setMode', mode });
    });

    function setPressed(el, on) { el.setAttribute('aria-pressed', on ? 'true' : 'false'); }

    thinkToggle.addEventListener('click', () => {
        const on = thinkToggle.getAttribute('aria-pressed') !== 'true';
        setPressed(thinkToggle, on);
        vscode.postMessage({ type: 'setThinking', enabled: on });
    });

    attachToggle.addEventListener('click', () => {
        setPressed(attachToggle, attachToggle.getAttribute('aria-pressed') !== 'true');
    });

    modelSelect.addEventListener('change', () => vscode.postMessage({ type: 'setModel', model: modelSelect.value }));

    refreshModels.addEventListener('click', () => {
        connLabel.textContent = 'checking Ollama';
        vscode.postMessage({ type: 'refreshModels' });
    });

    newChat.addEventListener('click', () => {
        vscode.postMessage({ type: 'newChat' });
        turn = null;
        messages.innerHTML = welcomeTemplate;
        const wm = $('welcomeModel');
        if (wm) { wm.textContent = modelSelect.value; }
        setBusy(false);
        input.focus();
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
        const wm = $('welcomeModel');
        if (wm) { wm.textContent = modelSelect.value; }
    }

    window.addEventListener('message', (event) => {

        const message = event.data;

        switch (message.type) {

            case 'modelList':
                populateModels(message.models, message.currentModel);
                connDot.className = 'conn-dot ' + (message.connected ? 'online' : 'offline');
                connLabel.textContent = message.connected ? 'Ollama connected' : 'Ollama offline';
                conn.title = message.connected ? 'Connected to Ollama' : 'Could not reach Ollama. Is "ollama serve" running?';
                break;

            case 'modelChanged':
                if (modelSelect.value !== message.model) { modelSelect.value = message.model; }
                break;

            case 'modeChanged':
                applyMode(message.mode);
                break;

            case 'thinkingChanged':
                setPressed(thinkToggle, !!message.enabled);
                break;

            case 'contextAttached':
                addNote('📎  ' + message.relativePath + (message.truncated ? ' (truncated)' : ''));
                break;

            case 'toolCall':
                addNote(toolLabel(message.name, message.args));
                break;

            case 'status':
                setStatus(message.text);
                break;

            case 'startResponse':
                // A retried step may leave a half-finished reply behind.
                finishTurn();
                break;

            case 'thinking':
                addThinking(message.text);
                break;

            case 'token':
                addToken(message.text);
                break;

            case 'endResponse':
                finishTurn(message.stats);
                break;

            case 'complete':
                finishTurn();
                setBusy(false);
                if (message.stopped) { addNote('■  Stopped'); }
                input.focus();
                break;

            case 'error':
                finishTurn();
                setBusy(false);
                addError(message.text);
                break;

            case 'change':
                upsertChange(message.change);
                break;

            case 'pendingCount':
                pendingBar.classList.toggle('visible', message.count > 0);
                pendingText.textContent = message.count + (message.count === 1 ? ' change' : ' changes') + ' waiting for review';
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
                addNote((message.ok ? '✓  ' : '⚠  ') + message.text, message.ok ? 'ok' : 'fail');
                break;
        }
    });

    applyMode(mode);
    updateSendState();
    vscode.postMessage({ type: 'ready' });
})();
