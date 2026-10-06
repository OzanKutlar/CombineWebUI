import { restorePrunedFromIndex, reapplyBranchPrunes } from './prune.js';
import { switchVariant, removeVariant, findVariantIndex } from './messageTree.js';

// Tree mutations that change which responses sit on the active path.
//
// Model prunes rewrite earlier user messages, so the outgoing branch's prunes
// are undone while its tail is still attached, and the whole new path's
// prunes are replayed afterwards. The replay also restores prunes made before
// the fork, which the wholesale restore clears along with the rest.

function withBranchPrunes(conv, index, mutate) {
    if (!conv || !Array.isArray(conv.messages)) return false;
    if (!Number.isInteger(index) || index < 0 || index >= conv.messages.length) return false;
    if (typeof mutate !== 'function') return false;

    restorePrunedFromIndex(conv.messages, index - 1);
    let changed = false;
    try {
        changed = mutate() === true;
    } finally {
        reapplyBranchPrunes(conv);
    }
    return changed;
}

export function switchBranch(conv, index, target) {
    return withBranchPrunes(conv, index, () => switchVariant(conv, index, target));
}

export function removeBranch(conv, index, target) {
    return withBranchPrunes(conv, index, () => removeVariant(conv, index, target));
}

export function removeBranchByVid(conv, index, vid) {
    if (!conv || !Array.isArray(conv.messages)) return false;
    const k = findVariantIndex(conv.messages[index], vid);
    if (k < 0) return false;
    return removeBranch(conv, index, k);
}

/** Runs an arbitrary slot mutation (e.g. adding a response) with the same prune bookkeeping. */
export function withBranchChange(conv, index, mutate) {
    return withBranchPrunes(conv, index, mutate);
}
