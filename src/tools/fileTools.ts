import * as vscode from 'vscode';
import * as path from 'path';

/**
 * FileTools: sandboxed file operations for the Local Coding Agent.
 *
 * All paths are resolved relative to a configurable workspace root and
 * verified to stay inside it before any I/O happens — mirrors the sandboxing
 * approach used in the Spring Boot agent core (readFile/writeFile/listFiles).
 */

export class FileToolsError extends Error {
	constructor(message: string, public readonly code: 'OUT_OF_BOUNDS' | 'NOT_FOUND' | 'NO_WORKSPACE') {
		super(message);
		this.name = 'FileToolsError';
	}
}

/**
 * Resolves the workspace root the agent is allowed to operate in.
 * Throws if no workspace folder is open.
 */
export function getWorkspaceRoot(): vscode.Uri {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		throw new FileToolsError('No workspace folder is open.', 'NO_WORKSPACE');
	}
	// Single-root assumption for now; extend to multi-root later if needed.
	return folders[0].uri;
}

/**
 * Resolves a user-supplied relative path against the workspace root and
 * guarantees the result cannot escape that root (blocks "../../etc" style
 * traversal). Returns the safe absolute vscode.Uri.
 */
export function resolveSafePath(relativePath: string, root?: vscode.Uri): vscode.Uri {
	const workspaceRoot = root ?? getWorkspaceRoot();

	// Reject absolute paths and drive-letter/UNC tricks outright.
	if (path.isAbsolute(relativePath)) {
		throw new FileToolsError(
			`Absolute paths are not allowed: "${relativePath}"`,
			'OUT_OF_BOUNDS'
		);
	}

	const rootFsPath = path.resolve(workspaceRoot.fsPath);
	const resolvedFsPath = path.resolve(rootFsPath, relativePath);

	// Ensure resolvedFsPath is rootFsPath itself or a proper descendant of it.
	const isInside =
		resolvedFsPath === rootFsPath ||
		resolvedFsPath.startsWith(rootFsPath + path.sep);

	if (!isInside) {
		throw new FileToolsError(
			`Path "${relativePath}" resolves outside the workspace root.`,
			'OUT_OF_BOUNDS'
		);
	}

	return vscode.Uri.file(resolvedFsPath);
}

export interface WriteFileResult {
	relativePath: string;
	sizeBytes: number;
	created: boolean; // true if the file didn't exist before this write
}

/**
 * Writes text content to a file by path relative to the workspace root.
 * - Sandboxed via resolveSafePath (no path traversal, no absolute paths).
 * - Creates parent directories as needed.
 * - Overwrites existing files. Callers are responsible for getting
 *   user approval before calling this (see the diff-approval flow in
 *   agent/optimizeAndTest.ts) — this function itself does not prompt.
 */
export async function writeFile(
	relativePath: string,
	content: string,
	root?: vscode.Uri
): Promise<WriteFileResult> {
	const uri = resolveSafePath(relativePath, root);

	let created = false;
	try {
		await vscode.workspace.fs.stat(uri);
	} catch {
		created = true;
	}

	const dirUri = vscode.Uri.joinPath(uri, '..');
	await vscode.workspace.fs.createDirectory(dirUri);

	const bytes = new TextEncoder().encode(content);
	await vscode.workspace.fs.writeFile(uri, bytes);

	return {
		relativePath,
		sizeBytes: bytes.byteLength,
		created,
	};
}
export interface ReadFileResult {
	relativePath: string;
	content: string;
	sizeBytes: number;
}

/**
 * Reads a text file by path relative to the workspace root.
 * - Sandboxed via resolveSafePath (no path traversal).
 * - Returns decoded UTF-8 text plus basic metadata.
 * - Throws FileToolsError('NOT_FOUND') if the file doesn't exist.
 */
export async function readFile(relativePath: string, root?: vscode.Uri): Promise<ReadFileResult> {
	const uri = resolveSafePath(relativePath, root);

	let bytes: Uint8Array;
	try {
		bytes = await vscode.workspace.fs.readFile(uri);
	} catch (err: any) {
		if (err?.code === 'FileNotFound') {
			throw new FileToolsError(`File not found: "${relativePath}"`, 'NOT_FOUND');
		}
		throw err;
	}

	const content = new TextDecoder('utf-8').decode(bytes);

	return {
		relativePath,
		content,
		sizeBytes: bytes.byteLength,
	};
}