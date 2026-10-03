import * as vscode from 'vscode';
import { readFile, writeFile, FileToolsError } from '../tools/fileTools';
import { makeProposedUri, clearProposedUri } from '../diff/diffContentProvider';

/**
 * Delimiters the model is instructed to use. Chosen to be unlikely to
 * collide with real code or markdown the model might otherwise produce.
 */
const MARKERS = {
	codeStart: '---OPTIMIZED_CODE_START---',
	codeEnd: '---OPTIMIZED_CODE_END---',
	testPathStart: '---TEST_FILE_PATH_START---',
	testPathEnd: '---TEST_FILE_PATH_END---',
	testCodeStart: '---TEST_CODE_START---',
	testCodeEnd: '---TEST_CODE_END---',
	explanationStart: '---EXPLANATION_START---',
	explanationEnd: '---EXPLANATION_END---',
};

interface ParsedProposal {
	optimizedCode: string;
	testFilePath: string;
	testCode: string;
	explanation: string;
}

function extractBetween(text: string, startMarker: string, endMarker: string): string | undefined {
	const startIdx = text.indexOf(startMarker);
	const endIdx = text.indexOf(endMarker);
	if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
		return undefined;
	}
	return text.slice(startIdx + startMarker.length, endIdx).trim();
}

function parseProposal(raw: string): ParsedProposal {
	const optimizedCode = extractBetween(raw, MARKERS.codeStart, MARKERS.codeEnd);
	const testFilePath = extractBetween(raw, MARKERS.testPathStart, MARKERS.testPathEnd);
	const testCode = extractBetween(raw, MARKERS.testCodeStart, MARKERS.testCodeEnd);
	const explanation = extractBetween(raw, MARKERS.explanationStart, MARKERS.explanationEnd);

	if (!optimizedCode || !testFilePath || !testCode) {
		throw new Error(
			'Qwen\'s response did not match the expected format. Try again — occasionally the model drops a marker.'
		);
	}

	return {
		optimizedCode,
		testFilePath: testFilePath.replace(/^`+|`+$/g, '').trim(),
		testCode,
		explanation: explanation ?? '',
	};
}

async function callOllamaForProposal(
	ollamaUrl: string,
	model: string,
	relativePath: string,
	originalContent: string
): Promise<ParsedProposal> {

	const systemPrompt = `
You are a local coding assistant running inside VS Code, specialized in Java and Spring Boot.

You will be given a file's full content. Your job:
1. Optimize the code (readability, performance, correctness, idiomatic Java/Spring Boot) without changing its external behavior unless there's a clear bug.
2. Write a JUnit 5 test file covering the optimized code's public behavior.
3. Briefly explain what you changed and why.

You MUST respond using EXACTLY this structure, with nothing before or after it:

${MARKERS.codeStart}
<the full optimized file content, ready to replace the original file as-is>
${MARKERS.codeEnd}
${MARKERS.testPathStart}
<path to the test file, relative to the workspace root, e.g. src/test/java/com/example/FooTest.java>
${MARKERS.testPathEnd}
${MARKERS.testCodeStart}
<the full JUnit 5 test file content>
${MARKERS.testCodeEnd}
${MARKERS.explanationStart}
<2-5 sentences on what changed and why>
${MARKERS.explanationEnd}

Do not wrap code blocks in markdown triple-backticks. Output raw code only between the markers.
`;

	const userPrompt = `File: ${relativePath}\n\n${originalContent}`;

	const response = await fetch(`${ollamaUrl.replace(/\/$/, '')}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model,
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt },
			],
			stream: false,
		}),
	});

	if (!response.ok) {
		throw new Error(`Ollama returned HTTP ${response.status}: ${response.statusText}`);
	}

	const data: any = await response.json();
	const raw = data?.message?.content;

	if (!raw || typeof raw !== 'string') {
		throw new Error('Ollama returned an empty or malformed response.');
	}

	return parseProposal(raw);
}

/**
 * Full flow: read active file -> ask Ollama for optimized code + tests ->
 * show both as diffs -> write only if the user explicitly approves.
 */
export async function runOptimizeAndTest(
	ollamaUrl: string,
	model: string
): Promise<void> {

	const editor = vscode.window.activeTextEditor;

	if (!editor || editor.document.uri.scheme !== 'file') {
		vscode.window.showWarningMessage(
			'Local Coding Agent: open a file in the editor first, then run this command.'
		);
		return;
	}

	const relativePath = vscode.workspace.asRelativePath(editor.document.uri);
	const originalContent = editor.document.getText();

	let proposal: ParsedProposal;

	try {
		proposal = await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Local Coding Agent: optimizing ${relativePath} and drafting tests...`,
				cancellable: false,
			},
			() => callOllamaForProposal(ollamaUrl, model, relativePath, originalContent)
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Local Coding Agent: ${message}`);
		return;
	}

	// --- Diff 1: optimized version of the current file ---
	const proposedMainUri = makeProposedUri(
		relativePath.split('/').pop() ?? 'proposed.java',
		proposal.optimizedCode
	);

	await vscode.commands.executeCommand(
		'vscode.diff',
		editor.document.uri,
		proposedMainUri,
		`${relativePath} ↔ Optimized (proposed)`
	);

	// --- Diff 2: new JUnit test file (diffed against empty) ---
	let existingTestContent = '';
	try {
		const existing = await readFile(proposal.testFilePath);
		existingTestContent = existing.content;
	} catch (error) {
		if (!(error instanceof FileToolsError && error.code === 'NOT_FOUND')) {
			// An OUT_OF_BOUNDS path here means the model proposed something
			// unsafe — surface it rather than silently continuing.
			const message = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Local Coding Agent: ${message}`);
			clearProposedUri(proposedMainUri);
			return;
		}
	}

	const emptyOrExistingUri = makeProposedUri(
		'before-' + (proposal.testFilePath.split('/').pop() ?? 'Test.java'),
		existingTestContent
	);
	const proposedTestUri = makeProposedUri(
		proposal.testFilePath.split('/').pop() ?? 'ProposedTest.java',
		proposal.testCode
	);

	await vscode.commands.executeCommand(
		'vscode.diff',
		emptyOrExistingUri,
		proposedTestUri,
		`${proposal.testFilePath} (new test)`
	);

	// --- Explanation + approval ---
	const explanationSnippet = proposal.explanation
		? `\n\nWhat changed: ${proposal.explanation}`
		: '';

	const choice = await vscode.window.showInformationMessage(
		`Local Coding Agent proposed changes to ${relativePath} and a new test at ${proposal.testFilePath}. Review the two diff tabs.${explanationSnippet}`,
		{ modal: true },
		'Apply Both',
		'Discard'
	);

	clearProposedUri(proposedMainUri);
	clearProposedUri(emptyOrExistingUri);
	clearProposedUri(proposedTestUri);

	if (choice !== 'Apply Both') {
		vscode.window.setStatusBarMessage('Local Coding Agent: changes discarded.', 3000);
		return;
	}

	try {
		await writeFile(relativePath, proposal.optimizedCode);
		const testResult = await writeFile(proposal.testFilePath, proposal.testCode);

		vscode.window.showInformationMessage(
			`Local Coding Agent: updated ${relativePath} and ${testResult.created ? 'created' : 'updated'} ${proposal.testFilePath}.`
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`Local Coding Agent: failed to write changes — ${message}`);
	}
}