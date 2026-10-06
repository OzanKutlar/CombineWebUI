# CombineWebUI

A self-hosted chat interface for any **OpenAI-compatible API**. CombineWebUI has no built-in model provider. Every model comes from an endpoint you configure, such as the companion `copilot-api-py` proxy, Ollama, vLLM, LM Studio or a hosted API.

## Features

- **Folders and recents.** A nested folder tree with drag and drop, plus a chronological view.
- **Multiple responses per turn.** Ask several models the same question and switch between their replies as tabs.
- **Thinking traces.** Reasoning fields and inline `<think>` blocks are captured and shown in a collapsible panel. You can choose per model whether to replay them into context.
- **Context pruning.** A drawer for removing large file blocks from earlier messages. AI-requested `PRUNE` payloads are honoured too.
- **Payload cards.** `EXECUTION`, `PRUNE` and `SELECT` payloads from combineCopy-style prompts render as compact cards with diff stats.
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

## Configuration

- **`settings.json`** sits in the project root. It holds endpoints, provider logos, pricing and UI preferences. It is created on first run and is **git-ignored**, because it contains API keys.
- **Chat data** lives in `~/.local/share/combine-webui`. On first start, history from `~/.local/share/copilot-api` is copied over once. The original files are left untouched.

## License

MIT. See [LICENSE](LICENSE).
