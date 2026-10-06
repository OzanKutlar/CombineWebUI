export const STORAGE_KEY_CONVS = 'copilot_conversations_v3';
export const STORAGE_KEY_ACTIVE = 'copilot_active_conv_v3';
export const STORAGE_KEY_MODEL = 'copilot_chat_model_v1';
export const STORAGE_KEY_AUTONAME_MODEL = 'copilot_autoname_model_v1';
export const STORAGE_KEY_HIDDEN = 'copilot_hidden_models_v1';
export const STORAGE_KEY_SIDEBAR_VIEW_MODE = 'copilot_sidebar_view_mode_v1';
export const STORAGE_KEY_THINKING_PREFS = 'copilot_thinking_prefs_v1';
export const STORAGE_KEY_PRESERVE_MODELS = 'copilot_preserve_thinking_models_v1';

// NOTE: this key is also hardcoded in the pre-paint bootstrap script in
// index.html, which cannot import from here without reintroducing a flash of
// the wrong theme. Change both together.
export const STORAGE_KEY_THEME = 'copilot_theme_v1';
export const DEFAULT_THEME = 'dark';

// Display-only prefs. Per-model context preservation lives in its own map and
// defaults to off simply by having no key present for that model.
export const DEFAULT_THINKING_PREFS = Object.freeze({
    show: true,
    autoExpand: false,
    inlineTags: ['think', 'thinking', 'reasoning']
});

export const DEFAULT_TOKEN_LIMIT = 1000000;

export const MODEL_LIMITS_DB_NAME = 'copilot_model_limits_db';
export const MODEL_LIMITS_DB_VERSION = 1;
export const MODEL_LIMITS_STORE = 'model_limits';

export const CHAT_DB_NAME = 'copilot_chats_db';
export const CHAT_DB_VERSION = 1;
export const CHAT_STORE = 'chats_store';

export const MAX_FOLDER_DEPTH = 8;

// Folders and their collapsed state persist inside the backend chats.json blob
// alongside conversations, so no dedicated localStorage keys are required.

// Auto-naming reads only the user's request plus the first assistant reply.
// System instructions, file context, AST maps and diffs never reach the model.
export const AUTO_NAME_MAX_CHARS = 5000;

// Reasoning models spend their budget thinking before emitting any visible
// content, so a tight cap returns an empty title. This is a safety net for
// servers that ignore AUTO_NAME_REASONING_EFFORT, not a target length: the
// naming system prompt is what actually constrains the title to five words.
export const AUTO_NAME_MAX_TOKENS = 1000;

// Asks the endpoint to skip reasoning entirely. Not universally supported,
// so the naming request retries without it when the server rejects the field.
export const AUTO_NAME_REASONING_EFFORT = 'none';

// Auto-folder parameters
export const AUTO_FOLDER_MAX_TOKENS = 4096;
export const AUTO_FOLDER_MAX_CHATS = 200;
export const AUTO_FOLDER_MAX_NEW_FOLDERS = 50;
