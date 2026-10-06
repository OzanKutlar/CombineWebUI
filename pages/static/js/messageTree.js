// Message tree helpers.
//
// `conv.messages` always holds the currently selected path, so every
// index-based consumer (prune targets, DOM ids, chat nav, token counts) keeps
// seeing one linear thread. An assistant slot where the thread forks carries
// its alternatives on `variants`:
//
//   variants[activeVariant]  -> { vid, tail: [] }  placeholder only; the live
//                               fields on the slot itself are the truth
//   variants[k], k != active -> { vid, tail, ...fields }  a stashed response
//                               plus every message that followed it
//
// Tails are ordinary messages, so they can fork again. This module is pure
// data: no DOM, no storage, no network.

export const MAX_VARIANTS = 16;

// Keys that describe the slot rather than any one response.
const STRUCTURAL_KEYS = new Set(['role', 'variants', 'activeVariant']);

// Keys that describe a stashed variant rather than the response it holds.
const VARIANT_META_KEYS = new Set(['vid', 'tail']);

let vidCounter = 0;
let inFlightVid = null;

function newVid() {
    vidCounter = (vidCounter + 1) % 1000000;
    const rand = Math.random().toString(36).slice(2, 7);
    return `v_${Date.now().toString(36)}_${vidCounter.toString(36)}_${rand}`;
}

function isAssistantSlot(msg) {
    return Boolean(msg) && typeof msg === 'object' && msg.role === 'assistant';
}

function isValidIndex(list, index) {
    return Array.isArray(list) && Number.isInteger(index) && index >= 0 && index < list.length;
}

function slotAt(conv, index) {
    if (!conv || !isValidIndex(conv.messages, index)) return null;
    const msg = conv.messages[index];
    return isAssistantSlot(msg) ? msg : null;
}

function copyLiveFields(msg) {
    const out = {};
    Object.keys(msg).forEach(key => {
        if (!STRUCTURAL_KEYS.has(key)) out[key] = msg[key];
    });
    return out;
}

function clearLiveFields(msg) {
    Object.keys(msg).forEach(key => {
        if (!STRUCTURAL_KEYS.has(key)) delete msg[key];
    });
}

function loadFields(msg, source) {
    clearLiveFields(msg);
    Object.keys(source).forEach(key => {
        if (!VARIANT_META_KEYS.has(key) && !STRUCTURAL_KEYS.has(key)) msg[key] = source[key];
    });
}

/** Marks which variant is being generated right now, or clears it with null. */
export function setInFlightVariant(vid) {
    inFlightVid = (typeof vid === 'string' && vid) ? vid : null;
}

export function isVariantInFlight(vid) {
    return Boolean(vid) && vid === inFlightVid;
}

export function hasVariantArray(msg) {
    return isAssistantSlot(msg) && Array.isArray(msg.variants) && msg.variants.length > 0;
}

/** Read-only: a legacy assistant message counts as a single response. */
export function getVariantCount(msg) {
    if (!isAssistantSlot(msg)) return 0;
    return hasVariantArray(msg) ? msg.variants.length : 1;
}

export function getActiveVariantIndex(msg) {
    if (!hasVariantArray(msg)) return 0;
    return isValidIndex(msg.variants, msg.activeVariant) ? msg.activeVariant : 0;
}

/** The object holding variant k's fields: the slot itself when k is active. */
export function getVariantView(msg, k) {
    if (!isAssistantSlot(msg)) return null;
    if (!hasVariantArray(msg)) return k === 0 ? msg : null;
    if (!isValidIndex(msg.variants, k)) return null;
    return k === getActiveVariantIndex(msg) ? msg : msg.variants[k];
}

export function getVariantVid(msg, k) {
    if (!hasVariantArray(msg) || !isValidIndex(msg.variants, k)) return '';
    const v = msg.variants[k];
    return (v && typeof v.vid === 'string') ? v.vid : '';
}

export function findVariantIndex(msg, vid) {
    if (!hasVariantArray(msg) || typeof vid !== 'string' || !vid) return -1;
    return msg.variants.findIndex(v => Boolean(v) && v.vid === vid);
}

/**
 * Upgrades a slot to carry a variants array. A legacy slot becomes a single
 * placeholder; a malformed array is repaired without discarding any stash.
 */
export function ensureVariants(msg) {
    if (!isAssistantSlot(msg)) return false;

    if (!hasVariantArray(msg)) {
        msg.variants = [{ vid: newVid(), tail: [] }];
        msg.activeVariant = 0;
        return true;
    }

    msg.variants = msg.variants.filter(v => Boolean(v) && typeof v === 'object');
    msg.variants.forEach(v => {
        if (typeof v.vid !== 'string' || !v.vid) v.vid = newVid();
        if (!Array.isArray(v.tail)) v.tail = [];
    });

    if (!isValidIndex(msg.variants, msg.activeVariant)) {
        // The live fields have no placeholder. Give them one rather than let
        // them silently shadow whichever stash sits at index 0.
        msg.variants.push({ vid: newVid(), tail: [] });
        msg.activeVariant = msg.variants.length - 1;
    }
    return true;
}

/** Moves the active response and everything after it into its placeholder. */
function stashActive(conv, index) {
    const msg = conv.messages[index];
    const k = msg.activeVariant;
    const placeholder = msg.variants[k];
    const tail = conv.messages.slice(index + 1);
    msg.variants[k] = Object.assign(copyLiveFields(msg), { vid: placeholder.vid, tail });
    conv.messages = conv.messages.slice(0, index + 1);
}

/** Resolves where a variant's fields currently live, or null if it is gone. */
export function findVariantTarget(conv, index, vid) {
    const msg = slotAt(conv, index);
    const k = findVariantIndex(msg, vid);
    if (k < 0) return null;
    return k === getActiveVariantIndex(msg) ? msg : msg.variants[k];
}

/** Replaces a variant's response fields wholesale, keeping its identity. */
export function replaceVariantFields(conv, index, vid, fields) {
    const target = findVariantTarget(conv, index, vid);
    if (!target || !fields || typeof fields !== 'object') return false;

    if (target === conv.messages[index]) {
        clearLiveFields(target);
    } else {
        Object.keys(target).forEach(key => {
            if (!VARIANT_META_KEYS.has(key)) delete target[key];
        });
    }
    Object.keys(fields).forEach(key => {
        if (!VARIANT_META_KEYS.has(key) && !STRUCTURAL_KEYS.has(key)) target[key] = fields[key];
    });
    return true;
}

/**
 * Adds a pending response at an assistant slot and makes it active. The
 * previous response keeps its tail, so the thread after this slot is empty
 * until the new response is continued. Returns the new vid, or '' on failure.
 */
export function addVariant(conv, index, seed) {
    const msg = slotAt(conv, index);
    if (!msg || !ensureVariants(msg)) return '';
    if (msg.variants.length >= MAX_VARIANTS) return '';

    stashActive(conv, index);
    const vid = newVid();
    msg.variants.push({ vid, tail: [] });
    msg.activeVariant = msg.variants.length - 1;
    loadFields(msg, (seed && typeof seed === 'object') ? seed : {});
    return vid;
}

/** Swaps the displayed response at a slot and restores that response's tail. */
export function switchVariant(conv, index, target) {
    const msg = slotAt(conv, index);
    if (!msg || !ensureVariants(msg)) return false;
    if (!isValidIndex(msg.variants, target) || target === msg.activeVariant) return false;

    const incoming = msg.variants[target];
    const tail = Array.isArray(incoming.tail) ? incoming.tail : [];

    stashActive(conv, index);
    loadFields(msg, incoming);
    msg.variants[target] = { vid: incoming.vid, tail: [] };
    msg.activeVariant = target;
    conv.messages = conv.messages.concat(tail);
    return true;
}

/**
 * Deletes one response and its tail. Removing the active one switches to a
 * neighbour first; removing the only one deletes the slot, like the old delete.
 */
export function removeVariant(conv, index, target) {
    const msg = slotAt(conv, index);
    if (!msg || !ensureVariants(msg)) return false;
    if (!isValidIndex(msg.variants, target)) return false;

    if (msg.variants.length === 1) {
        conv.messages.splice(index, 1);
        return true;
    }

    if (target === msg.activeVariant) {
        const neighbour = target > 0 ? target - 1 : 1;
        if (!switchVariant(conv, index, neighbour)) return false;
    }

    msg.variants.splice(target, 1);
    if (target < msg.activeVariant) msg.activeVariant -= 1;
    return true;
}
