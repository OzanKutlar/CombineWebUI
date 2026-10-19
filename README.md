# CombineWebUI

A self-hosted chat interface for any **OpenAI-compatible API**. CombineWebUI has no built-in model provider. Every model comes from an endpoint you configure, such as the companion `copilot-api-py` proxy, Ollama, vLLM, LM Studio or a hosted API.

## Features

- **Folders and recents.** A nested folder tree with drag and drop, plus a chronological view.
- **Multiple responses per turn.** Ask several models the same question and switch between their replies as tabs.
- **Thinking traces.** Reasoning fields and inline `<think>` blocks are captured and shown in a collapsible panel. You can choose per model whether to replay them into context.
- **Context pruning.** A drawer for removing large file blocks from earlier messages. AI-requested `PRUNE` payloads are honoured too.
- **Cache-aware pruning.** New prunes are held back while the target model's prompt cache is warm, then applied once it cools, on a model switch, near the context limit, or on demand. The policy and cache TTL are set per endpoint.
- **Payload cards.** `EXECUTION`, `PRUNE` and `SELECT` payloads from combineCopy-style prompts render as compact cards with diff stats. XML payloads with any `<*_payload>` root tag are recognised.
- **Agent identity.** combineCopy prompts are re-targeted on each request. The `{{IDENTITY}}` placeholder, and optionally a hardcoded `<identity>` line, is filled to match the target model, a preset or your own text. The setting is under Settings, Display. Only the system instructions are rewritten, and saved chats are never changed.
- **Token counter.** Per-model and per-provider totals, trend charts and cost estimates from your own price table.
- **Auto Name and Auto Folder.** Uses any configured model, and warns before using a metered one.
- **Themes and live sync.** Gruvbox dark, hard and light themes. Open tabs stay in sync over server-sent events.

## Requirements

- Python 3.9 or newer
- At least one OpenAI-compatible endpoint

## Quick start

```sh
pip install -r requirements.txt
python main.py start
```

Then open `http://localhost:4142/`.

### Using it with copilot-api-py

1. Start the proxy: `python main.py start` inside `copilot-api-py`. It listens on port 4141.
2. Start CombineWebUI. On its first run it adds an endpoint named **Copilot** that points at `http://localhost:4141/v1`.

Copilot models carry a premium `multiplier`, so CombineWebUI marks them as **metered**.

## Commands

| Command | Description |
| --- | --- |
| `python main.py start [--host H] [--port P] [-v] [--proxy-env]` | Start the server (default `127.0.0.1:4142`) |
| `python main.py token-counter [--json] [--refresh] [--clear-cache]` | Tally tokens across all saved chats |
| `python main.py cli [-c CHAT] [-l LABEL] [-v]` | Clipboard chat console with no server and no API calls. See [CLI mode](#cli-mode-no-server) |

## CLI mode (no server)

For machines where you may not host a server but can use an approved AI web chat. `python main.py cli` never opens a socket and never calls an API. The conversation travels through your clipboard, as in Human Hands, and is stored in the same chat files the web UI uses, so a thread can move between the two.

```sh
pip install -r requirements-cli.txt
python main.py cli -l "Claude (web)"
```

1. Pick a chat (recent first, **＋ New chat…** last), or pass `-c <chat id>`.
2. Add a prompt:
   - Copy a combineCopy payload and run `paste`. It is staged: `drop 2 5` leaves files out, `edit` opens the request in micro, and `send` adds it.
   - Run `edit` to write a prompt in micro in this terminal. Save and quit, and the text becomes the prompt.
   - Run `say` to type one, or `paste` any other text.
3. The prompt is now on your clipboard. Paste it into the web chat, copy the model's reply, and run `reply`. The reply is rendered as markdown, PRUNE and EXECUTION payloads appear as cards, and PRUNE payloads are applied.
4. Repeat. Copies hold **new messages only** by default. `swap` switches the clipboard to the full conversation for a fresh web chat.

### Cache-aware pruning in a web chat

The web chat plays the role of the provider's prompt cache. Each label has its own `policy`, `ttl` and `limit`, stored in `~/.local/share/combine-webui/cli.json`. The defaults are deferred, 300 seconds and 200k tokens.

- While you keep pasting new messages into the same web chat, a prune (yours or the AI's) cannot remove anything that chat already has, so it is **held**.
- Held prunes become **due** once the TTL has passed since the last reply, or once the web chat reaches 85% of `limit`. `copy` then warns and estimates what a fresh chat would save.
- `swap` or `copy full` starts a fresh web chat with every prune applied. `flush`, or `policy immediate`, makes the next copy full automatically.
- A send is recorded when you run `reply`, from what was copied, so swapping back and forth before you paste costs nothing.

The state uses the web UI's own `cacheWarmth` and `sentPrunes` fields, with the label as the scope.

### CLI commands

Type `help` in the console for the full list. The main ones:

| Command | What it does |
| --- | --- |
| `paste`, `say`, `edit` | Add a prompt from the clipboard, typed, or written in micro |
| `drop`, `undrop`, `send`, `discard` | Edit and commit a staged combineCopy payload |
| `copy [new\|full]`, `swap` | Copy the conversation, or switch between new and full |
| `reply`, `undo`, `edit last` | Record the reply, take back the last message, or rewrite an unanswered prompt |
| `files`, `prune`, `restore`, `aiprune` | List files and prune or restore them by number or path |
| `cache`, `flush`, `policy`, `ttl`, `limit`, `label` | Cache state and per-label settings |
| `chat`, `chats`, `show`, `history`, `status` | Navigation and inspection |

### CLI notes

- **Editor.** micro is found on PATH or in its usual Windows install folders. Set `COMBINE_CLI_EDITOR` (for example `nano`) to use another editor; `VISUAL` and `EDITOR` are the fallback.
- **Tokens.** `tiktoken` downloads its encoding on first use. On an offline machine, set `COMBINE_CLI_TOKENIZER=heuristic` or leave tiktoken uninstalled, and a characters / 4 estimate is used.
- **Identity.** The web UI's identity setting applies. In auto mode the label decides: `Claude (web)` fills in Claude, while a label naming no model family fills `{{IDENTITY}}` neutrally and leaves a hardcoded `<identity>` line alone.
- **Linux clipboard.** pyperclip needs `xclip`, `xsel` or `wl-clipboard`.
- **Running next to the web UI.** CLI edits are not pushed to open browser tabs, so reload the chat there. Avoid editing the same chat in both at once.

## Configuration

- **`settings.json`** sits in the project root. It holds endpoints, provider logos, pricing and UI preferences. It is created on first run and is **git-ignored**, because it contains API keys.
- **Chat data** lives in `~/.local/share/combine-webui`. On first start, history from `~/.local/share/copilot-api` is copied over once. The original files are left untouched.

## License

MIT. See [LICENSE](LICENSE).
