/**
 * Minimal line-based diff (LCS) used to turn "here is the whole new file"
 * into a handful of targeted hunks, so only the lines that actually changed
 * are touched in the editor instead of rewriting the entire document.
 */

export interface LineHunk {
	/** First line (0-based) in the old text that this hunk replaces. */
	oldStart: number;
	/** Number of old lines replaced (0 = pure insertion). */
	oldLength: number;
	/** Replacement lines from the new text. */
	newLines: string[];
}

const MAX_CELLS = 4_000_000;

export function splitLines(text: string): string[] {
	return text.split(/\r?\n/);
}

export function diffLines(oldText: string, newText: string): LineHunk[] {

	const a = splitLines(oldText);
	const b = splitLines(newText);

	// Trim common prefix / suffix first: cheap, and keeps the LCS table small.
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
		prefix++;
	}

	let suffix = 0;
	while (
		suffix < a.length - prefix &&
		suffix < b.length - prefix &&
		a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
	) {
		suffix++;
	}

	const aMid = a.slice(prefix, a.length - suffix);
	const bMid = b.slice(prefix, b.length - suffix);

	if (aMid.length === 0 && bMid.length === 0) {
		return [];
	}

	// Fall back to one big hunk if the middle is too large for an LCS table.
	if (aMid.length * bMid.length > MAX_CELLS || aMid.length === 0 || bMid.length === 0) {
		return [{ oldStart: prefix, oldLength: aMid.length, newLines: bMid }];
	}

	const n = aMid.length;
	const m = bMid.length;
	const table: Uint32Array[] = [];
	for (let i = 0; i <= n; i++) {
		table.push(new Uint32Array(m + 1));
	}

	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i][j] = aMid[i] === bMid[j]
				? table[i + 1][j + 1] + 1
				: Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}

	const hunks: LineHunk[] = [];
	let current: LineHunk | undefined;
	let i = 0;
	let j = 0;

	const flush = () => {
		if (current) {
			hunks.push(current);
			current = undefined;
		}
	};

	while (i < n || j < m) {

		if (i < n && j < m && aMid[i] === bMid[j]) {
			flush();
			i++;
			j++;
			continue;
		}

		if (!current) {
			current = { oldStart: prefix + i, oldLength: 0, newLines: [] };
		}

		if (j < m && (i >= n || table[i][j + 1] >= table[i + 1][j])) {
			current.newLines.push(bMid[j]);
			j++;
		} else {
			current.oldLength++;
			i++;
		}
	}

	flush();
	return hunks;
}
