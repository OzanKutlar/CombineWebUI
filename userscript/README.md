# Antigravity AI Chat Scaffolding & Execution Parser (Userscript)

A lightweight, universal Tampermonkey userscript that parses structured prompt scaffolding (`combineCopy`, `--- FILE CONTEXT ---`, `--- USER REQUEST ---`) and `EXECUTION` JSON payloads into clean, collapsible cards directly inside AI web interfaces.

## Supported Platforms
- **Google Gemini** (`gemini.google.com`)
- **Anthropic Claude** (`claude.ai`)
- **OpenAI ChatGPT** (`chatgpt.com`)
- **DeepSeek** (`chat.deepseek.com`)
- Any standard markdown web UI with prompt/response blocks

## Features
1. **Structured Prompt Cleanup**: Collapses thousands of lines of AST maps, file context, and system prompts into neat accordions, highlighting only the actual user request.
2. **Execution Payload Cards**: Formats `{"phase": "EXECUTION", ...}` and `<antigravity_payload>` into visual cards with `+` / `-` file line diff stats.
3. **1-Click Copy**: Copies the exact, untouched execution JSON directly to your clipboard for local agent runners.
4. **Toggle Raw Text**: Non-destructive; switch between the parsed view and original text at any moment.

## How to Install
1. Install the [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/) browser extension.
2. Click the Tampermonkey extension icon and choose **Create a new script**.
3. Copy the contents of `antigravity-chat-parser.user.js` and paste it into the editor.
4. Save (`Ctrl+S` or `Cmd+S`).
5. Open [Google Gemini](https://gemini.google.com) or any supported AI chat interface and start prompting!
