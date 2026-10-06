/**
 * Shared category rail for tabbed modals.
 *
 * Extracted from settings.js so the Settings and Token Counter dialogs cannot
 * drift apart. Only one panel is mounted at a time; the rail owns its own
 * scroll so a long list cannot push the dialog footer off screen.
 *
 * The click listener is installed once per rail and dispatches through
 * `rail._modalTabsSwitch`, which is reassigned on every wire call. Without
 * that indirection a re-wire would leave the listener closed over a stale
 * config, silently ignoring the newest onSwitch handler.
 */

export function wireModalTabs(config) {
    const opts = config || {};
    const rail = document.getElementById(opts.railId);
    const host = document.getElementById(opts.hostId);
    if (!rail || !host) return () => {};

    const tabClass = opts.tabClass || 'modal-tab';
    const activeTabClass = opts.activeTabClass || 'modal-tab-active';
    const panelClass = opts.panelClass || 'modal-panel';
    const activePanelClass = opts.activePanelClass || 'modal-panel-active';
    const panels = Array.isArray(opts.panels) ? opts.panels : [];

    function switchTo(panelId) {
        if (!panelId) return;
        // An unknown id would hide every panel and leave the dialog blank.
        if (panels.length > 0 && panels.indexOf(panelId) === -1) return;

        rail.querySelectorAll('.' + tabClass).forEach(btn => {
            btn.classList.toggle(activeTabClass, btn.getAttribute('data-panel') === panelId);
        });

        host.querySelectorAll('.' + panelClass).forEach(section => {
            section.classList.toggle(activePanelClass, section.getAttribute('data-panel') === panelId);
        });

        if (typeof opts.onSwitch === 'function') opts.onSwitch(panelId);
    }

    rail._modalTabsSwitch = switchTo;

    if (!rail._modalTabsWired) {
        rail._modalTabsWired = true;
        rail.addEventListener('click', (e) => {
            const btn = e.target.closest('.' + tabClass);
            if (!btn || !rail.contains(btn)) return;
            if (typeof rail._modalTabsSwitch === 'function') {
                rail._modalTabsSwitch(btn.getAttribute('data-panel'));
            }
        });
    }

    return switchTo;
}
