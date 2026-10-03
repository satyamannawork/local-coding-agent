import * as assert from 'assert';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { readFile, resolveSafePath, FileToolsError } from '../..//tools/fileTools';

/**
 * Test suite for FileTools.readFile.
 * Run via: npm run test   (uses @vscode/test-cli + @vscode/test-electron)
 *
 * These tests bypass vscode.workspace.workspaceFolders by passing an
 * explicit `root` Uri into readFile/resolveSafePath, so they work in an
 * isolated temp dir without needing a real workspace open.
 */
suite('FileTools.readFile', () => {
	let tmpDir: vscode.Uri;

	suiteSetup(async () => {
		const base = await fs.mkdtemp(path.join(os.tmpdir(), 'local-coding-agent-'));
		tmpDir = vscode.Uri.file(base);
	});

	suiteTeardown(async () => {
		await fs.rm(tmpDir.fsPath, { recursive: true, force: true });
	});

	test('reads an existing file and returns exact content', async () => {
		const expected = 'Hello from Local Coding Agent';
		await fs.writeFile(path.join(tmpDir.fsPath, 'sample.txt'), expected, 'utf-8');

		const result = await readFile('sample.txt', tmpDir);

		assert.strictEqual(result.content, expected);
		assert.strictEqual(result.relativePath, 'sample.txt');
		assert.strictEqual(result.sizeBytes, Buffer.byteLength(expected, 'utf-8'));
	});

	test('reads a file inside a nested subdirectory', async () => {
		const nestedDir = path.join(tmpDir.fsPath, 'src', 'nested');
		await fs.mkdir(nestedDir, { recursive: true });
		await fs.writeFile(path.join(nestedDir, 'deep.ts'), '// nested content', 'utf-8');

		const result = await readFile('src/nested/deep.ts', tmpDir);

		assert.strictEqual(result.content, '// nested content');
	});

	test('throws NOT_FOUND for a missing file', async () => {
		await assert.rejects(
			async () => readFile('does-not-exist.txt', tmpDir),
			(err: unknown) => {
				assert.ok(err instanceof FileToolsError);
				assert.strictEqual(err.code, 'NOT_FOUND');
				return true;
			}
		);
	});

	test('throws OUT_OF_BOUNDS for path traversal attempts', async () => {
		await assert.rejects(
			async () => readFile('../../etc/passwd', tmpDir),
			(err: unknown) => {
				assert.ok(err instanceof FileToolsError);
				assert.strictEqual(err.code, 'OUT_OF_BOUNDS');
				return true;
			}
		);
	});

	test('throws OUT_OF_BOUNDS for absolute paths', async () => {
		await assert.rejects(
			async () => readFile('/etc/passwd', tmpDir),
			(err: unknown) => {
				assert.ok(err instanceof FileToolsError);
				assert.strictEqual(err.code, 'OUT_OF_BOUNDS');
				return true;
			}
		);
	});

	test('resolveSafePath allows the root itself', () => {
		const resolved = resolveSafePath('.', tmpDir);
		assert.strictEqual(path.resolve(resolved.fsPath), path.resolve(tmpDir.fsPath));
	});

	test('reads an empty file without error', async () => {
		await fs.writeFile(path.join(tmpDir.fsPath, 'empty.txt'), '', 'utf-8');

		const result = await readFile('empty.txt', tmpDir);

		assert.strictEqual(result.content, '');
		assert.strictEqual(result.sizeBytes, 0);
	});
});
