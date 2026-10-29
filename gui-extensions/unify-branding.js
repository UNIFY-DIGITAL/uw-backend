/**
 * Unify branding for the Puter desktop — configurable, no Puter source change.
 *
 * Bundled into the desktop at build time (PUTER_GUI_EXTENSION_PATHS, see
 * scripts/build-desktop.sh). Everything it shows comes from the server's
 * config.json, under "gui_params":
 *
 *   "brand_name":         "Unify Works"            replaces "Puter" in the desktop
 *   "brand_logo_url":     "/unify/logo.svg"        logo on light backgrounds
 *   "brand_logo_dark_url":"/unify/logo-white.svg"  logo on dark backgrounds (optional)
 *   "brand_wallpaper_url":"/unify/wallpaper.webp"  default wallpaper (optional)
 *
 * With no "brand_name" it changes nothing. Puter's trademark guidelines do not
 * allow a modified version to present itself as Puter, which is why a
 * self-hosted suite sets one.
 *
 * Why at runtime rather than by editing strings: the desktop is Puter's code,
 * updated upstream; overriding the few seams it exposes (window.i18n,
 * window.icons, the page title) and correcting the remaining rendered text
 * keeps every Puter upgrade a rebuild rather than a merge.
 */

const params = () => window.gui_params || {};
const brand = () => (typeof params().brand_name === 'string' ? params().brand_name.trim() : '');
// Global patterns for replace(); separate non-global ones for test(), whose
// global form remembers lastIndex between calls and skips matches.
const PUTER = /\bPuter\b/g;
const HAS_PUTER = /\bPuter\b/;
const CDN_WALLPAPER = /https:\/\/puter-assets\.b-cdn\.net\/wallpaper\.webp/g;
const HAS_CDN_WALLPAPER = /https:\/\/puter-assets\.b-cdn\.net\/wallpaper\.webp/;

// Text that names the product. Lower-case `puter` (code, URLs, file paths)
// is left alone; only the capitalised product name is replaced.
const rebrandText = (text) => (brand() && typeof text === 'string' ? text.replace(PUTER, brand()) : text);

// 1. Every translated interface string, in every language, at lookup time.
(function wrapI18n () {
    if ( typeof window.i18n !== 'function' || window.i18n.__unifyBranded ) {
        // i18n.js may load after this file: try again once it exists.
        if ( ! window.i18n ) setTimeout(wrapI18n, 0);
        return;
    }
    const original = window.i18n;
    window.i18n = function (...args) {
        return rebrandText(original.apply(this, args));
    };
    window.i18n.__unifyBranded = true;
})();

// 2. Logos, the root folder's name and the page title, once gui() has run
//    and window.gui_params exists.
function applyStatic () {
    if ( ! brand() ) return false;
    const p = params();
    if ( window.icons ) {
        if ( p.brand_logo_url ) {
            window.icons['logo.svg'] = p.brand_logo_url;
            window.icons['logo.png'] = p.brand_logo_url;
        }
        if ( p.brand_logo_dark_url || p.brand_logo_url ) {
            window.icons['logo-white.svg'] = p.brand_logo_dark_url || p.brand_logo_url;
        }
    }
    if ( window.root_dirname === 'Puter' ) window.root_dirname = brand();
    if ( document.title ) document.title = rebrandText(document.title);
    return true;
}

// 3. Text and images the desktop renders without going through i18n (the
//    dashboard header, tooltips, alt text, the default wallpaper), corrected
//    as they appear.
function rebrandNode (root) {
    if ( ! brand() ) return;
    const p = params();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement && !n.parentElement.closest('input, textarea, [contenteditable], iframe, script, style')
            && HAS_PUTER.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
    });
    for ( let n = walker.nextNode(); n; n = walker.nextNode() ) n.nodeValue = rebrandText(n.nodeValue);
    const elements = root.querySelectorAll ? [root, ...root.querySelectorAll('[alt], [title], [aria-label], [style], img')] : [];
    for ( const el of elements ) {
        if ( !el.getAttribute ) continue;
        for ( const attr of ['alt', 'title', 'aria-label'] ) {
            const v = el.getAttribute(attr);
            if ( v && HAS_PUTER.test(v) ) el.setAttribute(attr, rebrandText(v));
        }
        if ( p.brand_logo_url && el.tagName === 'IMG' && /\/logo(-white)?\.(svg|png)/.test(el.getAttribute('src') || '') ) {
            const dark = /logo-white/.test(el.getAttribute('src'));
            const want = dark ? (p.brand_logo_dark_url || p.brand_logo_url) : p.brand_logo_url;
            // Only when it differs: setting src fires this observer again.
            if ( el.getAttribute('src') !== want ) el.setAttribute('src', want);
        }
        const style = el.getAttribute('style');
        if ( style && HAS_CDN_WALLPAPER.test(style) ) {
            el.setAttribute('style', style.replace(CDN_WALLPAPER, p.brand_wallpaper_url || '/images/wallpaper.webp'));
        }
    }
}

let staticApplied = false;
const observer = new MutationObserver((mutations) => {
    if ( ! staticApplied ) staticApplied = applyStatic();
    for ( const m of mutations ) {
        if ( m.type === 'characterData' && m.target.parentNode ) rebrandNode(m.target.parentNode);
        for ( const node of m.addedNodes || [] ) {
            if ( node.nodeType === Node.ELEMENT_NODE ) rebrandNode(node);
            else if ( node.nodeType === Node.TEXT_NODE && node.parentNode ) rebrandNode(node.parentNode);
        }
        if ( m.type === 'attributes' && m.target.nodeType === Node.ELEMENT_NODE ) rebrandNode(m.target);
    }
});
const start = () => {
    observer.observe(document.documentElement, {
        childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['alt', 'title', 'aria-label', 'style', 'src'],
    });
    staticApplied = applyStatic();
    if ( document.body ) rebrandNode(document.body);
};
if ( document.readyState === 'loading' ) document.addEventListener('DOMContentLoaded', start);
else start();

// The tab title changes with focus and open windows; keep it branded.
new MutationObserver(() => {
    if ( brand() && HAS_PUTER.test(document.title) ) document.title = rebrandText(document.title);
}).observe(document.querySelector('title') || document.head, { childList: true, subtree: true, characterData: true });

console.debug('[unify] branding extension loaded');
