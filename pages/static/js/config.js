export const STORAGE_KEY_CONVS = 'copilot_conversations_v3';
export const STORAGE_KEY_ACTIVE = 'copilot_active_conv_v3';
export const STORAGE_KEY_MODEL = 'copilot_chat_model_v1';
export const STORAGE_KEY_AUTONAME_MODEL = 'copilot_autoname_model_v1';
export const STORAGE_KEY_HIDDEN = 'copilot_hidden_models_v1';
export const STORAGE_KEY_SIDEBAR_VIEW_MODE = 'copilot_sidebar_view_mode_v1';
export const STORAGE_KEY_THINKING_PREFS = 'copilot_thinking_prefs_v1';
export const STORAGE_KEY_PRESERVE_MODELS = 'copilot_preserve_thinking_models_v1';
export const STORAGE_KEY_FAVORITE_MODELS = 'copilot_favorite_models_v1';

// Header favorites bar. Favorites whose endpoint is offline or that are hidden
// still count toward the cap, because they are kept so they can reappear.
export const MAX_FAVORITE_MODELS = 12;

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

// Cache-aware pruning. "deferred" holds new prunes back while the target
// model's prompt cache is warm; "immediate" applies them on the next send.
export const PRUNE_POLICY_DEFERRED = 'deferred';
export const PRUNE_POLICY_IMMEDIATE = 'immediate';

// Anthropic's default cache lifetime. Endpoints override it in Settings.
export const DEFAULT_CACHE_TTL_SECONDS = 300;
export const MIN_CACHE_TTL_SECONDS = 30;
export const MAX_CACHE_TTL_SECONDS = 3600;

// Pending prunes are committed regardless of warmth once the context sent to a
// model would exceed this share of its known token limit.
export const CONTEXT_PRESSURE_RATIO = 0.8;

// Countdown refresh for the footer while prunes are pending.
export const PENDING_REFRESH_MS = 5000;

// Upper bound on per-conversation cache scopes (one per model id).
export const MAX_CACHE_SCOPES = 64;

// Fired when the selected model gains or loses pending prunes, so prune cards
// can repaint without re-rendering the chat on every countdown tick.
export const PRUNE_PENDING_EVENT = 'ag:prune-pending-changed';
