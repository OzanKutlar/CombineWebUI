/**
 * Animated folder-name reveal for the sidebar tree.
 *
 * The chip is fixed-position rather than in-flow because #conv-list is a
 * scroll container: anything expanding horizontally inside it would be clipped
 * at the sidebar edge. This is the same escape hatch popupMenu.js uses.
 *
 * A single chip element is reused for every folder row; only one can be open
 * at a time, so there is nothing to stack or garbage collect.
 */

const CHIP_ID = 'folder-name-reveal-chip';
const OPEN_DELAY_MS = 120;
const VIEWPORT_GAP = 16;
const MAX_CHIP_WIDTH = 420;
const BORDER_ALLOWANCE = 2;

let openTimer = null;
let activeRow = null;

/** Pointer-less devices have no hover, so the chip would be unreachable. */
function supportsHover() {
    if (typeof window.matchMedia !== 'function') return true;
    return window.matchMedia('(hover: hover)').matches;
}

function clearOpenTimer() {
    if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
    }
}

export function hideFolderNameChip() {
    clearOpenTimer();
    activeRow = null;

    const chip = document.getElementById(CHIP_ID);
    if (!chip) return;
    chip.classList.remove('folder-name-chip-open');
    chip.style.maxWidth = '0px';
}

function getChip() {
    const existing = document.getElementById(CHIP_ID);
    if (existing) return existing;

    const chip = document.createElement('div');
    chip.id = CHIP_ID;
    chip.className = 'folder-name-chip';

    const inner = document.createElement('div');
    inner.className = 'folder-name-chip-inner';
    chip.appendChild(inner);

    document.body.appendChild(chip);

    // Registered once, alongside the element they belong to. Capture phase so a
    // scroll inside the sidebar's own overflow container is caught too.
    window.addEventListener('scroll', hideFolderNameChip, true);
    window.addEventListener('resize', hideFolderNameChip);

    return chip;
}

/** True only when the label is genuinely cut off; short names never animate. */
function isTruncated(labelEl) {
    if (!labelEl) return false;
    return (labelEl.scrollWidth - labelEl.clientWidth) > 1;
}

/**
 * Measures the chip's natural width with the transition suppressed, resets it
 * to collapsed, then animates out to the clamped target. Measuring with the
 * transition live would animate towards a moving target.
 */
function openChip(rowEl, name) {
    const chip = getChip();
    const inner = chip.firstElementChild;
    if (!inner) return;

    inner.textContent = name;

    const rect = rowEl.getBoundingClientRect();
    chip.style.left = Math.max(VIEWPORT_GAP, rect.left) + 'px';
    chip.style.top = rect.top + 'px';
    chip.style.minHeight = rect.height + 'px';

    chip.style.transition = 'none';
    chip.style.maxWidth = 'none';
    const natural = Math.ceil(inner.getBoundingClientRect().width) + BORDER_ALLOWANCE;
    chip.style.maxWidth = '0px';
    void chip.offsetWidth;
    chip.style.transition = '';

    const room = window.innerWidth - Math.max(VIEWPORT_GAP, rect.left) - VIEWPORT_GAP;
    const target = Math.max(0, Math.min(natural, MAX_CHIP_WIDTH, room));

    chip.classList.add('folder-name-chip-open');
    chip.style.maxWidth = target + 'px';
}

/**
 * Wires hover reveal onto a sidebar item row (folder or conversation). Opening is delayed
 * so sweeping the cursor down the list does not fire a cascade; closing is immediate.
 */
export function attachNameReveal(rowEl, labelEl, name) {
    if (!rowEl || !labelEl) return;
    if (typeof name !== 'string' || !name) return;
    if (!supportsHover()) return;

    rowEl.addEventListener('mouseenter', () => {
        if (!isTruncated(labelEl)) return;

        clearOpenTimer();
        activeRow = rowEl;
        openTimer = setTimeout(() => {
            openTimer = null;
            if (activeRow !== rowEl) return;
            if (!rowEl.isConnected) return;
            openChip(rowEl, name);
        }, OPEN_DELAY_MS);
    });

    rowEl.addEventListener('mouseleave', hideFolderNameChip);
    rowEl.addEventListener('dragstart', hideFolderNameChip);
    rowEl.addEventListener('click', hideFolderNameChip);
}

export const attachFolderNameReveal = attachNameReveal;
