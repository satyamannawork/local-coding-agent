# Local Coding Agent

A local AI coding assistant for Visual Studio Code (Windows, macOS, and Linux) powered by Ollama.

## Features

- **Local AI inference using Ollama** — no cloud API, no source code ever leaves your machine
- **Real project-wide agent, not just the open tab** — the assistant can call `list_workspace_files` and `read_file` itself to explore your codebase (e.g. "explain what this project does") instead of only seeing whatever file you currently have open
- **Multi-turn memory** — the chat remembers the conversation as you go; click **New Chat** in the header to clear it and start fresh
- **Model picker** — switch between any model you have pulled in Ollama right from the chat header, or via `Local Coding Agent: Select Model` in the Command Palette
- **Faster responses** — the extension asks Ollama to keep your model loaded in memory between messages (`keep_alive`), avoiding the multi-second reload penalty large local models otherwise pay on every request; a Stop button lets you cancel a generation in flight
- **Streaming chat** in a sidebar view that opens automatically alongside your project
- **Project-aware context** — optionally attaches your currently open file to each message (toggle in the chat header)
- **Ask / Agent modes** — pick the mode in the dropdown under the chat (or run `Local Coding Agent: Switch Mode`):
  - **Ask** answers questions with read-only tools (`list_workspace_files`, `read_file`, `search_workspace`). Click **Apply** on a code block to put it in a file: a full-file block only replaces the lines that actually differ, and a snippet replaces your selection or goes in at the cursor.
  - **Agent** changes your project itself. It edits files with `edit_file`, which replaces one exact snippet instead of rewriting the whole file. It creates files with `create_file` and runs terminal commands with `run_command`.
- **Approve / Undo for every change** — each edit is applied in place right away, highlighted in the editor, and shown as a card in the chat. Use **Approve** or **Undo** on the card or in the CodeLens above the changed lines. New files get **Approve** or **Reject** (Reject deletes the file). **View diff** shows the change against the previous version. **Approve all** and **Undo all** appear above the input while changes are pending.
- **Terminal commands with approval** — when the agent wants to run a command, the chat shows it with **Run** and **Reject**. You can edit the command first. Approved commands run in a dedicated *Local Coding Agent* terminal, and their output goes back to the agent. Press Ctrl+C in that terminal or click **Stop** to cancel.
- **Optimize & Test** command — asks the model to refactor the active file and generate matching tests, previewed as diffs before anything is written
- **Raise Pull Request** command — commits, pushes, and opens a PR via the `gh` CLI

## Requirements

- Visual Studio Code 1.85 or newer (macOS, Windows, or Linux)
- [Ollama](https://ollama.com) installed and running
- At least one model pulled, e.g. `ollama pull qwen3-coder:30b`
- Tool calling (project-wide file exploration) requires a model that supports it — Qwen3-Coder, Qwen3, and Llama 3.1+ all do. If you pick a model without tool support, the assistant will just answer from whatever context it has instead of exploring the project.

## Ollama Setup

```
ollama serve
ollama pull qwen3-coder:30b
```

By default the extension talks to Ollama at `http://127.0.0.1:11434`. Change this under
**Settings → Local Coding Agent** (`localCodingAgent.ollamaUrl`) if your Ollama runs elsewhere.

## Settings

| Setting | Default | Description |
|---|---|---|
| `localCodingAgent.ollamaUrl` | `http://127.0.0.1:11434` | Ollama server URL |
| `localCodingAgent.model` | `qwen3-coder:30b` | Default model (overridden per-session by the picker) |
| `localCodingAgent.keepAlive` | `30m` | How long Ollama keeps the model loaded between requests |
| `localCodingAgent.includeActiveFileByDefault` | `true` | Whether the active file is attached as context by default |
| `localCodingAgent.contextLength` | `16384` | Ollama context window (`num_ctx`); Agent mode needs room for tools and files |
| `localCodingAgent.maxAgentSteps` | `25` | Max model/tool round trips per message in Agent mode |
| `localCodingAgent.commandTimeoutSeconds` | `120` | Approved commands are stopped after this long |

## Getting Started on macOS

1. Copy this project folder to the Mac (AirDrop, USB, `scp`, whatever's easiest) — or just copy the `.vsix` file alone if you don't need to rebuild it there.
2. Make sure Ollama is running: `ollama serve` (or just open the Ollama app). You said this Mac already has it with `qwen3:14b` pulled — confirm with `ollama list`.
3. Install the extension in VS Code: Command Palette → **Extensions: Install from VSIX...** → pick the `.vsix`. (If you only copied the project folder and need to build the `.vsix` first, see "Building from source" below.)
4. Open a project folder in VS Code. The chat view should open automatically; if the Activity Bar icon isn't visible, use Command Palette → **Local Coding Agent: Open**.
5. In the chat header's model dropdown, pick `qwen3:14b` (it should appear automatically once Ollama is reachable — the dropdown lists whatever models that Ollama instance actually has).

### Building from source (if you copied the folder, not the .vsix)

```
cd local-coding-agent
npm install
npm run vsix
```

This produces `local-coding-agent.vsix` in the project folder — install that via **Extensions: Install from VSIX...** as above.

### Note on qwen3:14b vs qwen3-coder

`qwen3:14b` is a general-purpose model, not a coding-specialized one like `qwen3-coder`. It'll work fine for chat and project Q&A, and it does support tool calling (so the agent can still explore your project via `list_workspace_files`/`read_file`). Code-generation quality may be somewhat weaker than a dedicated coder model, and being smaller (14B vs 30B) it should also respond noticeably faster on typical Mac hardware.
