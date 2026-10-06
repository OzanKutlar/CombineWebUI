import { getActiveConversation } from './storage.js';
import { parseCombineCopyPrompt } from './promptParser.js';
import { getVariantCount } from './messageTree.js';
import { deriveShortName } from './avatar.js';

let activeObserver = null;
let currentActiveIndex = 0;

function isEditableTarget(el) {
    if (!el) return false;
    const tag = el.tagName ? el.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return el.isContentEditable === true;
}

function getMessagePreview(msg) {
    if (!msg || typeof msg.content !== 'string') return '';
    if (msg.role === 'user') {
        const parsed = parseCombineCopyPrompt(msg.content);
        const text = parsed.isStructured ? (parsed.userRequest || '') : msg.content;
        return (text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    }
    return msg.content.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function variantSuffix(msg) {
    const count = getVariantCount(msg);
    if (count < 2) return '';
    const name = msg.model ? deriveShortName(msg.model) : 'unknown';
    return ` · ${count} responses (${name} active)`;
}

// Gap left above a message when it is scrolled into view.
const SCROLL_TOP_GAP = 16;
// offsetParent chains here are a few levels deep; this only stops a detached
// or malformed tree from walking forever.
const MAX_OFFSET_WALK = 64;

function prefersReducedMotion() {
    if (typeof window.matchMedia !== 'function') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The scrollTop at which `target` sits flush with the top of `container`.
 * offsetTop ignores transforms, so a message still running its fade-in-up
 * entrance is measured where it will settle rather than 10px low. This relies
 * on #chat-container being positioned, which makes it the offsetParent.
 */
function getMessageScrollTop(container, target) {
    if (!container || !target || !container.contains(target)) return null;

    let top = 0;
    let node = target;
    for (let depth = 0; depth < MAX_OFFSET_WALK && node; depth++) {
        if (node === container) return top;
        top += node.offsetTop;
        node = node.offsetParent;
    }

    // Only reached if the container stopped being positioned. Rect math still
    // lands correctly once entrance animations have finished.
    const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    return container.scrollTop + delta;
}

function resolveMessageTarget(index) {
    const idx = Number(index);
    if (!Number.isInteger(idx) || idx < 0) return null;

    const container = document.getElementById('chat-container');
    const target = document.getElementById(`msg-wrap-${idx}`);
    const top = getMessageScrollTop(container, target);
    if (top === null) return null;
    return { container, idx, top };
}

function scrollContainerTo(container, top) {
    container.scrollTo({
        top: Math.max(0, top),
        behavior: prefersReducedMotion() ? 'auto' : 'smooth'
    });
}

export function scrollToMessage(index) {
    const resolved = resolveMessageTarget(index);
    if (!resolved) return;
    scrollContainerTo(resolved.container, resolved.top - SCROLL_TOP_GAP);
    setActiveTick(resolved.idx);
}

/**
 * Brings the top of a message into view. With `onlyIfAbove`, nothing moves
 * unless that top is currently scrolled out of sight above the view, so a
 * reader who already scrolled back up is left where they are.
 * Returns true when a scroll was issued.
 */
export function scrollToMessageTop(index, options) {
    const resolved = resolveMessageTarget(index);
    if (!resolved) return false;

    const onlyIfAbove = Boolean(options && options.onlyIfAbove);
    if (onlyIfAbove && resolved.top >= resolved.container.scrollTop) return false;

    scrollContainerTo(resolved.container, resolved.top - SCROLL_TOP_GAP);
    setActiveTick(resolved.idx);
    return true;
}

function setActiveTick(index) {
    currentActiveIndex = index;
    const list = document.getElementById('chat-nav-list');
    if (!list) return;

    list.querySelectorAll('.chat-nav-tick').forEach(tick => {
        const tickIdx = Number(tick.getAttribute('data-idx'));
        const isActive = tickIdx === index;
        tick.classList.toggle('chat-nav-tick-active', isActive);
    });
}

function stepNav(direction) {
    const active = getActiveConversation();
    const messages = active ? active.messages : [];
    if (messages.length === 0) return;

    let nextIndex = currentActiveIndex + direction;
    nextIndex = Math.max(0, Math.min(messages.length - 1, nextIndex));
    scrollToMessage(nextIndex);
}

export function destroyChatNav() {
    if (activeObserver) {
        activeObserver.disconnect();
        activeObserver = null;
    }
    currentActiveIndex = 0;
}

export function renderChatNav() {
    destroyChatNav();

    const rail = document.getElementById('chat-nav-rail');
    const list = document.getElementById('chat-nav-list');
    const container = document.getElementById('chat-container');
    if (!rail || !list || !container) return;

    list.innerHTML = '';

    const active = getActiveConversation();
    const messages = active ? active.messages : [];

    if (messages.length < 2) {
        rail.classList.add('hidden');
        return;
    }

    rail.classList.remove('hidden');

    let userCount = 0;
    let assistantCount = 0;

    messages.forEach((msg, idx) => {
        const isUser = msg.role === 'user';
        const isError = msg.isError === true;
        let iconName = 'sparkles';
        let roleClass = 'chat-nav-tick-assistant';
        let roleName = 'Assistant Reply';

        if (isUser) {
            userCount++;
            iconName = 'user';
            roleClass = 'chat-nav-tick-user';
            roleName = `User Request (#${userCount})`;
        } else if (isError) {
            assistantCount++;
            iconName = 'alert-triangle';
            roleClass = 'chat-nav-tick-error';
            roleName = `Error Response (#${assistantCount})`;
        } else {
            assistantCount++;
            iconName = 'sparkles';
            roleClass = 'chat-nav-tick-assistant';
            roleName = `Assistant Reply (#${assistantCount})`;
        }

        const tick = document.createElement('button');
        tick.className = `chat-nav-tick ${roleClass}`;
        tick.setAttribute('data-idx', String(idx));
        tick.innerHTML = `<i data-lucide="${iconName}"></i>`;
        
        const preview = getMessagePreview(msg);
        const titleText = `${roleName}${variantSuffix(msg)}${preview ? ': ' + preview : ''}`;
        tick.title = titleText;
        tick.setAttribute('aria-label', titleText);

        tick.onclick = () => scrollToMessage(idx);
        list.appendChild(tick);
    });

    // Highlight current active index
    if (currentActiveIndex >= messages.length) {
        currentActiveIndex = messages.length - 1;
    }
    setActiveTick(currentActiveIndex);

    // Observe messages to track active position on manual scroll
    if ('IntersectionObserver' in window) {
        activeObserver = new IntersectionObserver((entries) => {
            const visible = entries.filter(e => e.isIntersecting);
            if (visible.length > 0) {
                // Pick topmost visible message
                visible.sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
                const topEl = visible[0].target;
                const idStr = topEl.id || '';
                const idx = parseInt(idStr.replace('msg-wrap-', ''), 10);
                if (!isNaN(idx)) {
                    setActiveTick(idx);
                }
            }
        }, {
            root: container,
            rootMargin: '0px 0px -70% 0px',
            threshold: 0
        });

        messages.forEach((_, idx) => {
            const el = document.getElementById(`msg-wrap-${idx}`);
            if (el) activeObserver.observe(el);
        });
    }

    lucide.createIcons();
}

export function wireChatNav() {
    const prevBtn = document.getElementById('chat-nav-prev');
    const nextBtn = document.getElementById('chat-nav-next');

    if (prevBtn) prevBtn.onclick = () => stepNav(-1);
    if (nextBtn) nextBtn.onclick = () => stepNav(1);

    document.addEventListener('keydown', (e) => {
        if (!e.altKey) return;
        if (isEditableTarget(document.activeElement)) return;

        if (e.key === 'ArrowUp') {
            e.preventDefault();
            stepNav(-1);
        } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            stepNav(1);
        }
    });
}
