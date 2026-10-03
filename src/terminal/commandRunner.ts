import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'child_process';

/**
 * Runs shell commands the developer approved, streaming their output live
 * into a dedicated "Local Coding Agent" terminal (a pseudoterminal, so the
 * extension can also capture the output and hand it back to the model).
 */

export interface CommandResult {
	exitCode: number | null;
	output: string;
	timedOut: boolean;
	cancelled: boolean;
}

const MAX_CAPTURE = 60_000;

export class CommandRunner implements vscode.Disposable {

	private terminal?: vscode.Terminal;
	private writeEmitter = new vscode.EventEmitter<string>();
	private current?: ChildProcess;
	private opened = false;
	private queue: string[] = [];
	private readonly closeListener: vscode.Disposable;

	constructor() {
		this.closeListener = vscode.window.onDidCloseTerminal(t => {
			if (t === this.terminal) {
				this.terminal = undefined;
				this.kill();
			}
		});
	}

	dispose(): void {
		this.kill();
		this.closeListener.dispose();
		this.terminal?.dispose();
		this.writeEmitter.dispose();
	}

	public run(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {

		const terminal = this.ensureTerminal();
		terminal.show(true);

		this.write(`\x1b[1;36m$ ${command}\x1b[0m\r\n`);

		return new Promise<CommandResult>((resolve) => {

			let output = '';
			let timedOut = false;
			let cancelled = false;
			let settled = false;

			const isWindows = process.platform === 'win32';
			const child = spawn(command, {
				cwd,
				shell: true,
				env: { ...process.env, FORCE_COLOR: '0', CI: process.env.CI ?? '1' },
				// Own process group, so the whole tree can be killed on stop/timeout.
				detached: !isWindows
			});
			this.current = child;

			const capture = (chunk: Buffer) => {
				const text = chunk.toString('utf8');
				this.write(text.replace(/\r?\n/g, '\r\n'));
				if (output.length < MAX_CAPTURE) {
					output += text;
				}
			};

			child.stdout?.on('data', capture);
			child.stderr?.on('data', capture);

			const timer = setTimeout(() => {
				timedOut = true;
				this.kill();
			}, timeoutMs);

			const onAbort = () => {
				cancelled = true;
				this.kill();
			};
			signal?.addEventListener('abort', onAbort);

			const finish = (exitCode: number | null, extra = '') => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				if (this.current === child) {
					this.current = undefined;
				}
				const note = timedOut
					? `[stopped after ${Math.round(timeoutMs / 1000)}s timeout]`
					: cancelled ? '[cancelled]' : `[exit code ${exitCode}]`;
				this.write(`\x1b[2m${extra}${note}\x1b[0m\r\n\r\n`);
				resolve({
					exitCode,
					output: output.length >= MAX_CAPTURE ? output + '\n[...output truncated...]' : output,
					timedOut,
					cancelled
				});
			};

			child.on('error', err => finish(null, `Failed to start: ${err.message}\r\n`));
			child.on('close', code => finish(code));
		});
	}

	private kill(): void {
		const child = this.current;
		if (!child || child.pid === undefined || child.exitCode !== null) {
			return;
		}
		try {
			if (process.platform === 'win32') {
				spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
			} else {
				process.kill(-child.pid, 'SIGTERM');
			}
		} catch {
			child.kill();
		}
	}

	private write(text: string): void {
		// A pseudoterminal drops writes made before VS Code calls open().
		if (this.opened) {
			this.writeEmitter.fire(text);
		} else {
			this.queue.push(text);
		}
	}

	private ensureTerminal(): vscode.Terminal {

		if (this.terminal) {
			return this.terminal;
		}

		this.writeEmitter.dispose();
		this.writeEmitter = new vscode.EventEmitter<string>();
		const emitter = this.writeEmitter;
		this.opened = false;

		const pty: vscode.Pseudoterminal = {
			onDidWrite: emitter.event,
			open: () => {
				emitter.fire('\x1b[2mLocal Coding Agent: commands you approve run here. Press Ctrl+C to stop one.\x1b[0m\r\n\r\n');
				this.opened = true;
				for (const chunk of this.queue.splice(0)) {
					emitter.fire(chunk);
				}
			},
			close: () => {
				this.opened = false;
				this.kill();
			},
			handleInput: (data: string) => {
				if (data === '\x03') {
					this.kill();
				}
			}
		};

		this.terminal = vscode.window.createTerminal({ name: 'Local Coding Agent', pty });
		return this.terminal;
	}
}
