/**
 * Single shared popup menu for the sidebar.
 *
 * Fixed rather than absolute positioning: sidebar rows live inside an
 * overflow-y-auto container that would clip an absolutely positioned dropdown.
 * Only one menu can exist at a time, so nesting is a re-render in place rather
 * than a second stacked element.
 */

const MENU_ID = 'sidebar-menu-popup';
const ITEM_HEIGHT = 38;
const MENU_CHROME = 12;
const MENU_WIDTH = 210;
const MAX_MENU_HEIGHT = 320;
const EDGE_GAP = 8;

let outsideClickHandler = null;

export function closePopupMenu() {
    if (outsideClickHandler) {
        document.removeEventListener('click', outsideClickHandler);
        outsideClickHandler = null;
    }
    const existing = document.getElementById(MENU_ID);
    if (existing) existing.remove();
}

function buildItem(item, menu) {
    const btn = document.createElement('button');
    btn.type = 'button';

    const classes = ['popup-menu-item'];
    if (item.danger) classes.push('popup-menu-item-danger');
    if (item.active) classes.push('popup-menu-item-active');
    if (item.disabled) classes.push('popup-menu-item-disabled');
    btn.className = classes.join(' ');

    btn.disabled = item.disabled === true;
    if (item.title) btn.title = item.title;

    const icon = document.createElement('i');
    icon.setAttribute('data-lucide', item.icon || 'circle');
    icon.className = 'w-3.5 h-3.5 shrink-0';
    btn.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'truncate';
    label.textContent = item.label || '';
    btn.appendChild(label);

    btn.onclick = (e) => {
        e.stopPropagation();
        if (item.disabled === true) return;
        const result = typeof item.onSelect === 'function' ? item.onSelect() : null;
        // 'keep-open' lets an item re-render the menu in place (nested lists).
        if (result !== 'keep-open') closePopupMenu();
    };

    menu.appendChild(btn);
}

function positionMenu(menu, anchorEl, itemCount) {
    const rect = anchorEl.getBoundingClientRect();
    const height = Math.min(itemCount * ITEM_HEIGHT + MENU_CHROME, MAX_MENU_HEIGHT);

    const left = Math.max(EDGE_GAP, Math.min(rect.left, window.innerWidth - MENU_WIDTH - EDGE_GAP));

    // Flip above the anchor when there is not enough room below it.
    const spaceBelow = window.innerHeight - rect.bottom;
    const shouldFlip = spaceBelow < height && rect.top > height;
    const rawTop = shouldFlip
        ? rect.top - height - 4
        : Math.min(rect.bottom + 4, window.innerHeight - height - EDGE_GAP);

    menu.style.left = left + 'px';
    menu.style.top = Math.max(EDGE_GAP, rawTop) + 'px';
}

export function showPopupMenu(items, anchorEl) {
    closePopupMenu();
    if (!Array.isArray(items) || items.length === 0) return;
    if (!anchorEl || typeof anchorEl.getBoundingClientRect !== 'function') return;

    const menu = document.createElement('div');
    menu.id = MENU_ID;
    menu.className = 'popup-menu';
    menu.onclick = (e) => e.stopPropagation();

    items.forEach(item => buildItem(item, menu));
    document.body.appendChild(menu);

    positionMenu(menu, anchorEl, items.length);
    lucide.createIcons();

    // Deferred so the click that opened the menu does not immediately close it.
    // The identity check stops a superseded handler from ever being attached.
    const handler = () => closePopupMenu();
    outsideClickHandler = handler;
    setTimeout(() => {
        if (outsideClickHandler === handler) {
            document.addEventListener('click', handler);
        }
    }, 0);
}
