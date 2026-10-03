import * as vscode from 'vscode';

/**
 * Backs virtual documents used to preview proposed file changes in a
 * diff view before anything is written to disk. Content is held only
 * in memory, keyed by URI, and is transient (cleared once consumed).
 */

export const PROPOSED_SCHEME = 'local-coding-agent-proposed';

const contentMap = new Map<string, string>();
let counter = 0;

export class ProposedContentProvider implements vscode.TextDocumentContentProvider {

	private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
	public readonly onDidChange = this.changeEmitter.event;

	provideTextDocumentContent(uri: vscode.Uri): string {
		return contentMap.get(uri.toString()) ?? '';
	}
}

export function registerProposedContentProvider(
	context: vscode.ExtensionContext
): ProposedContentProvider {

	const provider = new ProposedContentProvider();

	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, provider)
	);

	return provider;
}

/**
 * Registers proposed content under a fresh virtual URI and returns that URI.
 * `label` is used only for the tab title (e.g. "SpringBootPoCsApplication.java").
 */
export function makeProposedUri(label: string, content: string): vscode.Uri {
	counter += 1;
	const safeLabel = label.replace(/[^a-zA-Z0-9._-]/g, '_');
	const uri = vscode.Uri.parse(`${PROPOSED_SCHEME}:/${counter}-${safeLabel}`);
	contentMap.set(uri.toString(), content);
	return uri;
}

export function clearProposedUri(uri: vscode.Uri): void {
	contentMap.delete(uri.toString());
}