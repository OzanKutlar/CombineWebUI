/**
 * Clipboard access, extracted so modules that must not depend on the message
 * action bar (codeblock.js) can share the same implementation.
 *
 * The Clipboard API is unavailable on insecure origins, which includes a
 * plain http://<lan-ip>:4141 the proxy is commonly reached on, so the hidden
 * textarea fallback is load-bearing rather than legacy.
 */

export async function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            console.warn('Clipboard API failed, trying fallback...', err);
        }
    }

    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
        document.execCommand('copy');
        textArea.remove();
        return true;
    } catch (err) {
        console.error('Fallback clipboard failed', err);
        textArea.remove();
        return false;
    }
}
