import * as vscode from 'vscode';
import * as path from 'path';
import { resolveSafePath } from '../tools/fileTools';
import { diffLines, splitLines, LineHunk } from '../diff/lineDiff';
import { makeProposedUri } from '../diff/diffContentProvider';

/**
 * EditManager: applies agent edits straight into the workspace, but only at
 * the exact spots that change, and keeps each one "pending" until the
 * developer approves it or undoes it (from the chat card or the CodeLens
 * shown above the changed lines in the editor).
 */

export type ChangeKind = 'edit' | 'create';
export type ChangeStatus = 'pending' | 'approved' | 'undone';

interface Fragment {
	/** Text inserted by the change, used to re-locate it as the file moves. */
	text: string;
	/** Line where the fragment started right after the edit was applied. */
	expectedLine: number;
}

export interface PendingChange {
	id: string;
	kind: ChangeKind;
	relativePath: string;
	uri: vscode.Uri;
	/** Full file text before the change (empty string for a created file). */
	before: string;
	/** Full file text right after the change. */
	after: string;
	/** For single search/replace edits, the exact replaced pair (for precise undo). */
	replaced?: { oldText: string; newText: string };
	fragments: Fragment[];
	added: number;
	removed: number;
	firstLine: number;
	status: ChangeStatus;
}

export interface ChangeSummary {
	id: string;
	kind: ChangeKind;
	relativePath: string;
	added: number;
	removed: number;
	firstLine: number;
	status: ChangeStatus;
}

export class EditError extends Error { }

let idCounter = 0;

function newId(): string {
	idCounter += 1;
	return `chg-${Date.now().toString(36)}-${idCounter}`;
}

export class EditManager implements vscode.CodeLensProvider, vscode.Disposable {

	private readonly changes = new Map<string, PendingChange>();
	private readonly disposables: vscode.Disposable[] = [];

	private readonly statusEmitter = new vscode.EventEmitter<ChangeSummary>();
	/** Fires whenever a change is created, approved or undone. */
	public readonly onDidChangeStatus = this.statusEmitter.event;

	private readonly codeLensEmitter = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses = this.codeLensEmitter.event;

	private readonly decoration = vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		backgroundColor: new vscode.ThemeColor('diffEditor.insertedLineBackground'),
		overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
		overviewRulerLane: vscode.OverviewRulerLane.Left
	});

	private refreshTimer?: NodeJS.Timeout;

	constructor() {
		this.disposables.push(
			this.decoration,
			vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
			vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
			vscode.workspace.onDidChangeTextDocument(e => {
				if (this.pendingFor(e.document.uri).length > 0) {
					this.scheduleRefresh();
				}
			})
		);
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
		this.statusEmitter.dispose();
		this.codeLensEmitter.dispose();
	}

	// ------------------------------------------------------------------ apply

	/**
	 * Replaces one specific snippet inside an existing file. Tries an exact
	 * match first, then a whitespace-tolerant line match (small local models
	 * often get indentation slightly wrong). Ambiguous matches are rejected so
	 * the model has to give more surrounding context.
	 */
	public async applySearchReplace(relativePath: string, oldString: string, newString: string): Promise<PendingChange> {

		const uri = resolveSafePath(relativePath);
		const doc = await this.openExisting(uri, relativePath);
		const text = doc.getText();
		const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';

		if (!oldString) {
			throw new EditError('old_string is empty. Provide the exact existing code to replace (use create_file for new files).');
		}

		const oldNorm = oldString.replace(/\r?\n/g, eol);
		let newNorm = newString.replace(/\r?\n/g, eol);

		let start = -1;
		let end = -1;

		const first = text.indexOf(oldNorm);
		if (first !== -1) {
			if (text.indexOf(oldNorm, first + 1) !== -1) {
				throw new EditError(`old_string matches more than one place in ${relativePath}. Include more surrounding lines so it is unique.`);
			}
			start = first;
			end = first + oldNorm.length;
		} else {
			const fuzzy = fuzzyLineMatch(text, oldString, eol);
			if (!fuzzy) {
				throw new EditError(`old_string was not found in ${relativePath}. Call read_file again and copy the exact current lines.`);
			}
			start = fuzzy.start;
			end = fuzzy.end;
			newNorm = reindent(newString, fuzzy.indentDelta).replace(/\r?\n/g, eol);
		}

		if (text.slice(start, end) === newNorm) {
			throw new EditError('new_string is identical to the existing code; nothing to change.');
		}

		const wasDirty = doc.isDirty;
		const edit = new vscode.WorkspaceEdit();
		edit.replace(uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end)), newNorm);
		await this.applyOrThrow(edit, relativePath);
		if (!wasDirty) {
			await doc.save();
		}

		const after = doc.getText();
		const startLine = doc.positionAt(start).line;
		const stats = countLines(text, after);

		const change: PendingChange = {
			id: newId(),
			kind: 'edit',
			relativePath,
			uri,
			before: text,
			after,
			replaced: { oldText: text.slice(start, end), newText: newNorm },
			fragments: newNorm ? [{ text: newNorm, expectedLine: startLine }] : [],
			added: stats.added,
			removed: stats.removed,
			firstLine: startLine,
			status: 'pending'
		};

		await this.register(change, doc);
		return change;
	}

	/**
	 * Takes a full proposed file body and applies only the hunks that differ
	 * from what is on disk. Creates the file if it doesn't exist yet.
	 */
	public async applyFullContent(relativePath: string, newContent: string): Promise<PendingChange> {

		const uri = resolveSafePath(relativePath);

		if (!(await exists(uri))) {
			return this.createFile(relativePath, newContent);
		}

		const doc = await this.openExisting(uri, relativePath);
		const text = doc.getText();
		const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
		let normalized = newContent.replace(/\r?\n/g, eol);
		// Keep the file's existing trailing-newline convention.
		if (text.endsWith(eol) && !normalized.endsWith(eol)) {
			normalized += eol;
		} else if (!text.endsWith(eol) && normalized.endsWith(eol)) {
			normalized = normalized.slice(0, -eol.length);
		}

		const hunks = diffLines(text, normalized);
		if (hunks.length === 0) {
			throw new EditError(`${relativePath} already matches the proposed content; nothing to change.`);
		}

		const wasDirty = doc.isDirty;
		const edit = new vscode.WorkspaceEdit();
		for (const hunk of hunks) {
			edit.replace(uri, hunkRange(doc, hunk), hunkText(doc, hunk, eol));
		}
		await this.applyOrThrow(edit, relativePath);
		if (!wasDirty) {
			await doc.save();
		}

		const fragments: Fragment[] = [];
		let delta = 0;
		for (const hunk of hunks) {
			if (hunk.newLines.length > 0) {
				fragments.push({ text: hunk.newLines.join(eol), expectedLine: hunk.oldStart + delta });
			}
			delta += hunk.newLines.length - hunk.oldLength;
		}

		const stats = countLines(text, doc.getText());
		const change: PendingChange = {
			id: newId(),
			kind: 'edit',
			relativePath,
			uri,
			before: text,
			after: doc.getText(),
			fragments,
			added: stats.added,
			removed: stats.removed,
			firstLine: hunks[0].oldStart,
			status: 'pending'
		};

		await this.register(change, doc);
		return change;
	}

	/** Inserts (or replaces the selection with) a snippet in an open editor. */
	public async applyAtSelection(editor: vscode.TextEditor, snippet: string): Promise<PendingChange> {

		const doc = editor.document;
		const relativePath = vscode.workspace.asRelativePath(doc.uri);
		const before = doc.getText();
		const selection = editor.selection;
		const startOffset = doc.offsetAt(selection.start);
		const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
		const text = snippet.replace(/\r?\n/g, eol);

		const wasDirty = doc.isDirty;
		const ok = await editor.edit(b => b.replace(selection, text));
		if (!ok) {
			throw new EditError(`VS Code refused the edit to ${relativePath}.`);
		}
		if (!wasDirty) {
			await doc.save();
		}

		const stats = countLines(before, doc.getText());
		const change: PendingChange = {
			id: newId(),
			kind: 'edit',
			relativePath,
			uri: doc.uri,
			before,
			after: doc.getText(),
			replaced: { oldText: before.slice(startOffset, doc.offsetAt(selection.end)), newText: text },
			fragments: text ? [{ text, expectedLine: selection.start.line }] : [],
			added: stats.added,
			removed: stats.removed,
			firstLine: selection.start.line,
			status: 'pending'
		};

		await this.register(change, doc);
		return change;
	}

	public async createFile(relativePath: string, content: string): Promise<PendingChange> {

		const uri = resolveSafePath(relativePath);

		if (await exists(uri)) {
			throw new EditError(`${relativePath} already exists. Use edit_file to change specific parts of it.`);
		}

		const edit = new vscode.WorkspaceEdit();
		edit.createFile(uri, { ignoreIfExists: false });
		edit.insert(uri, new vscode.Position(0, 0), content);
		await this.applyOrThrow(edit, relativePath);

		const doc = await vscode.workspace.openTextDocument(uri);
		await doc.save();

		const change: PendingChange = {
			id: newId(),
			kind: 'create',
			relativePath,
			uri,
			before: '',
			after: doc.getText(),
			fragments: content ? [{ text: doc.getText(), expectedLine: 0 }] : [],
			added: splitLines(content).length,
			removed: 0,
			firstLine: 0,
			status: 'pending'
		};

		await this.register(change, doc);
		return change;
	}

	// --------------------------------------------------------- approve / undo

	public approve(id: string): void {
		const change = this.changes.get(id);
		if (!change || change.status !== 'pending') {
			return;
		}
		change.status = 'approved';
		this.afterStatusChange(change);
	}

	public async undo(id: string): Promise<void> {

		const change = this.changes.get(id);
		if (!change || change.status !== 'pending') {
			return;
		}

		if (change.kind === 'create') {
			const edit = new vscode.WorkspaceEdit();
			edit.deleteFile(change.uri, { ignoreIfNotExists: true });
			await vscode.workspace.applyEdit(edit);
			change.status = 'undone';
			// Any later pending edits to the deleted file are moot now.
			for (const other of this.pendingFor(change.uri)) {
				other.status = 'undone';
				this.statusEmitter.fire(summarize(other));
			}
			this.afterStatusChange(change);
			return;
		}

		const doc = await vscode.workspace.openTextDocument(change.uri);
		const current = doc.getText();
		const edit = new vscode.WorkspaceEdit();

		if (current === change.after) {
			for (const hunk of diffLines(current, change.before)) {
				edit.replace(change.uri, hunkRange(doc, hunk), hunkText(doc, hunk, doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'));
			}
		} else if (change.replaced && change.replaced.newText) {
			const at = locate(current, change.replaced.newText, doc, change.firstLine);
			if (at === -1) {
				throw new EditError(`Can't undo: the edited code in ${change.relativePath} has since been changed.`);
			}
			edit.replace(
				change.uri,
				new vscode.Range(doc.positionAt(at), doc.positionAt(at + change.replaced.newText.length)),
				change.replaced.oldText
			);
		} else {
			const choice = await vscode.window.showWarningMessage(
				`${change.relativePath} changed after the agent's edit. Restore the version from before the edit? Later changes to this file will be lost.`,
				{ modal: true },
				'Restore'
			);
			if (choice !== 'Restore') {
				return;
			}
			edit.replace(change.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(current.length)), change.before);
		}

		const wasDirty = doc.isDirty;
		await this.applyOrThrow(edit, change.relativePath);
		if (!wasDirty) {
			await doc.save();
		}

		change.status = 'undone';
		this.afterStatusChange(change);
	}

	public approveAll(): void {
		for (const change of this.pending()) {
			this.approve(change.id);
		}
	}

	public async undoAll(): Promise<void> {
		// Newest first so stacked edits on one file unwind cleanly.
		for (const change of this.pending().reverse()) {
			try {
				await this.undo(change.id);
			} catch (error) {
				vscode.window.showWarningMessage(error instanceof Error ? error.message : String(error));
			}
		}
	}

	public async showDiff(id: string): Promise<void> {
		const change = this.changes.get(id);
		if (!change) {
			return;
		}
		const label = path.basename(change.relativePath);
		const beforeUri = makeProposedUri('before-' + label, change.before);
		await vscode.commands.executeCommand(
			'vscode.diff',
			beforeUri,
			change.uri,
			`${label}: agent changes`
		);
	}

	public async reveal(id: string): Promise<void> {
		const change = this.changes.get(id);
		if (!change || !(await exists(change.uri))) {
			return;
		}
		const doc = await vscode.workspace.openTextDocument(change.uri);
		const line = this.currentAnchorLine(change, doc);
		const editor = await vscode.window.showTextDocument(doc, { preview: false });
		const pos = new vscode.Position(line, 0);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
	}

	public pending(): PendingChange[] {
		return [...this.changes.values()].filter(c => c.status === 'pending');
	}

	public summary(id: string): ChangeSummary | undefined {
		const change = this.changes.get(id);
		return change ? summarize(change) : undefined;
	}

	// ---------------------------------------------------------------- CodeLens

	provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {

		const lenses: vscode.CodeLens[] = [];
		const text = document.getText();

		for (const change of this.pendingFor(document.uri)) {
			const line = this.currentAnchorLine(change, document, text);
			const range = new vscode.Range(line, 0, line, 0);
			const stats = `+${change.added} −${change.removed}`;
			lenses.push(
				new vscode.CodeLens(range, {
					title: '$(check) Approve',
					command: 'localCodingAgent.approveChange',
					arguments: [change.id]
				}),
				new vscode.CodeLens(range, {
					title: change.kind === 'create' ? '$(trash) Reject' : '$(discard) Undo',
					command: 'localCodingAgent.undoChange',
					arguments: [change.id]
				}),
				new vscode.CodeLens(range, {
					title: `Agent ${change.kind === 'create' ? 'created file' : 'edit'} (${stats})`,
					command: 'localCodingAgent.showChangeDiff',
					arguments: [change.id]
				})
			);
		}

		return lenses;
	}

	// ---------------------------------------------------------------- private

	private async register(change: PendingChange, doc: vscode.TextDocument): Promise<void> {

		this.changes.set(change.id, change);

		// Show the edited spot without stealing focus from the chat input.
		const editor = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: true });
		const pos = new vscode.Position(change.firstLine, 0);
		editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);

		this.afterStatusChange(change);
	}

	private afterStatusChange(change: PendingChange): void {
		this.statusEmitter.fire(summarize(change));
		this.codeLensEmitter.fire();
		this.refreshDecorations();
	}

	private pendingFor(uri: vscode.Uri): PendingChange[] {
		const key = uri.toString();
		return this.pending().filter(c => c.uri.toString() === key);
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}
		this.refreshTimer = setTimeout(() => this.refreshDecorations(), 150);
	}

	private refreshDecorations(): void {

		for (const editor of vscode.window.visibleTextEditors) {

			const doc = editor.document;
			const text = doc.getText();
			const ranges: vscode.Range[] = [];

			for (const change of this.pendingFor(doc.uri)) {
				for (const fragment of change.fragments) {
					const at = locate(text, fragment.text, doc, fragment.expectedLine);
					if (at !== -1) {
						const startLine = doc.positionAt(at).line;
						const endLine = doc.positionAt(at + fragment.text.length).line;
						ranges.push(new vscode.Range(startLine, 0, endLine, 0));
					}
				}
			}

			editor.setDecorations(this.decoration, ranges);
		}
	}

	private currentAnchorLine(change: PendingChange, doc: vscode.TextDocument, text = doc.getText()): number {
		const fragment = change.fragments[0];
		if (fragment) {
			const at = locate(text, fragment.text, doc, fragment.expectedLine);
			if (at !== -1) {
				return doc.positionAt(at).line;
			}
		}
		return Math.min(change.firstLine, Math.max(0, doc.lineCount - 1));
	}

	private async openExisting(uri: vscode.Uri, relativePath: string): Promise<vscode.TextDocument> {
		if (!(await exists(uri))) {
			throw new EditError(`File not found: ${relativePath}. Use create_file to make a new file.`);
		}
		return vscode.workspace.openTextDocument(uri);
	}

	private async applyOrThrow(edit: vscode.WorkspaceEdit, relativePath: string): Promise<void> {
		const ok = await vscode.workspace.applyEdit(edit);
		if (!ok) {
			throw new EditError(`VS Code refused the edit to ${relativePath}.`);
		}
	}
}

// -------------------------------------------------------------------- helpers

function summarize(change: PendingChange): ChangeSummary {
	return {
		id: change.id,
		kind: change.kind,
		relativePath: change.relativePath,
		added: change.added,
		removed: change.removed,
		firstLine: change.firstLine,
		status: change.status
	};
}

async function exists(uri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch {
		return false;
	}
}

function countLines(before: string, after: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const hunk of diffLines(before, after)) {
		added += hunk.newLines.length;
		removed += hunk.oldLength;
	}
	return { added, removed };
}

/** Range covering a hunk's old lines, including their line breaks. */
function hunkRange(doc: vscode.TextDocument, hunk: LineHunk): vscode.Range {
	const start = new vscode.Position(hunk.oldStart, 0);
	const endLine = hunk.oldStart + hunk.oldLength;
	if (endLine < doc.lineCount) {
		return new vscode.Range(start, new vscode.Position(endLine, 0));
	}
	// Hunk reaches end of file: there is no trailing line break to consume,
	// so eat the preceding one instead (when there is a preceding line).
	const docEnd = doc.lineAt(doc.lineCount - 1).range.end;
	if (hunk.oldStart > 0 && hunk.oldStart >= doc.lineCount) {
		return new vscode.Range(doc.lineAt(doc.lineCount - 1).range.end, docEnd);
	}
	if (hunk.oldStart > 0) {
		return new vscode.Range(doc.lineAt(hunk.oldStart - 1).range.end, docEnd);
	}
	return new vscode.Range(start, docEnd);
}

function hunkText(doc: vscode.TextDocument, hunk: LineHunk, eol: string): string {
	const endLine = hunk.oldStart + hunk.oldLength;
	if (endLine < doc.lineCount) {
		return hunk.newLines.map(l => l + eol).join('');
	}
	if (hunk.oldStart > 0) {
		return hunk.newLines.map(l => eol + l).join('');
	}
	return hunk.newLines.join(eol);
}

/** Finds the occurrence of `needle` whose line is closest to `expectedLine`. */
function locate(text: string, needle: string, doc: vscode.TextDocument, expectedLine: number): number {
	if (!needle) {
		return -1;
	}
	let best = -1;
	let bestDistance = Number.MAX_SAFE_INTEGER;
	let from = 0;
	for (let guard = 0; guard < 500; guard++) {
		const at = text.indexOf(needle, from);
		if (at === -1) {
			break;
		}
		const distance = Math.abs(doc.positionAt(at).line - expectedLine);
		if (distance < bestDistance) {
			best = at;
			bestDistance = distance;
		}
		from = at + 1;
	}
	return best;
}

interface FuzzyMatch {
	start: number;
	end: number;
	indentDelta: string;
}

/**
 * Matches old_string line-by-line ignoring leading/trailing whitespace.
 * Returns the character span of the matched whole lines when exactly one
 * location matches, plus the indentation the file uses at that spot.
 */
function fuzzyLineMatch(text: string, oldString: string, eol: string): FuzzyMatch | undefined {

	const needle = oldString.split(/\r?\n/);
	while (needle.length && !needle[0].trim()) { needle.shift(); }
	while (needle.length && !needle[needle.length - 1].trim()) { needle.pop(); }
	if (needle.length === 0) {
		return undefined;
	}

	const lines = text.split(eol);
	const trimmedNeedle = needle.map(l => l.trim());
	const matches: number[] = [];

	for (let i = 0; i + needle.length <= lines.length; i++) {
		let ok = true;
		for (let k = 0; k < needle.length; k++) {
			if (lines[i + k].trim() !== trimmedNeedle[k]) {
				ok = false;
				break;
			}
		}
		if (ok) {
			matches.push(i);
			if (matches.length > 1) {
				return undefined;
			}
		}
	}

	if (matches.length !== 1) {
		return undefined;
	}

	const lineIdx = matches[0];
	let start = 0;
	for (let i = 0; i < lineIdx; i++) {
		start += lines[i].length + eol.length;
	}
	let end = start;
	for (let k = 0; k < needle.length; k++) {
		end += lines[lineIdx + k].length + (k < needle.length - 1 ? eol.length : 0);
	}

	const fileIndent = /^\s*/.exec(lines[lineIdx])?.[0] ?? '';
	const modelIndent = /^\s*/.exec(needle[0])?.[0] ?? '';
	const indentDelta = fileIndent.startsWith(modelIndent) ? fileIndent.slice(modelIndent.length) : '';

	return { start, end, indentDelta };
}

function reindent(text: string, delta: string): string {
	const lines = text.split(/\r?\n/);
	while (lines.length && !lines[0].trim()) { lines.shift(); }
	while (lines.length && !lines[lines.length - 1].trim()) { lines.pop(); }
	if (!delta) {
		return lines.join('\n');
	}
	return lines.map(l => (l.trim() ? delta + l : l)).join('\n');
}
