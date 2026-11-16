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
 *   "support_email":      "support@unify.works"    in place of support@puter.com
 *   "website_url":        "https://unify.works"    links to puter.com
 *   "source_url":         "https://github.com/..." links to Puter's source ("Open Source")
 *   "terms_url", "privacy_url"                     Terms and Privacy links; hidden when unset
 *
 * Links to Puter's developer site, docs and community are hidden, and so are
 * the menus' "Developer" items.
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
const HAS_PUTER = /\bPuter\b|support@puter\.com/i;
const PUTER_SUPPORT = /support@puter\.com/gi;
const PUTER_DOT_COM = /\bPuter\.com\b/g;
const CDN_WALLPAPER = /https:\/\/puter-assets\.b-cdn\.net\/wallpaper\.webp/g;
const HAS_CDN_WALLPAPER = /https:\/\/puter-assets\.b-cdn\.net\/wallpaper\.webp/;
// Where links and support addresses lead (config.json gui_params, scripts/configure.sh).
const support = () => params().support_email || 'support@unify.works';

// Text that names the product. Lower-case `puter` (code, URLs, file paths)
// is left alone; only the capitalised product name, "Puter.com" and Puter's
// support address are replaced.
const rebrandText = (text) => (brand() && typeof text === 'string'
    ? text.replace(PUTER_SUPPORT, support()).replace(PUTER_DOT_COM, brand()).replace(PUTER, brand())
    : text);

// A link's destination on this server: ours for Puter's site, source code,
// terms, privacy and support; '' for Puter's developer site, docs and
// community, which have no counterpart (the link is hidden). Null: not Puter's,
// left as it is.
function linkFor (href) {
    if ( typeof href !== 'string' || !href ) return null;
    if ( /^mailto:support@puter\.com/i.test(href) ) return `mailto:${support()}`;
    let url;
    try {
        url = new URL(href, location.href);
    } catch {
        return null;
    }
    const host = url.hostname.toLowerCase();
    const p = params();
    const page = (path) => (path === '/terms' ? p.terms_url || '' : p.privacy_url || '');
    if ( host === location.hostname && (url.pathname === '/terms' || url.pathname === '/privacy') ) return page(url.pathname);
    if ( host === 'github.com' && /^\/heyputer\b/i.test(url.pathname) ) return p.source_url || '';
    if ( /^(developer|docs)\.puter\.com$/.test(host) || /(^|\.)discord\.(com|gg)$/.test(host) ) return '';
    if ( host === 'puter.com' || host === 'www.puter.com' ) {
        if ( url.pathname === '/terms' || url.pathname === '/privacy' ) return page(url.pathname);
        return p.website_url || location.origin;
    }
    return null;
}

// 1. Every translated interface string, in every language, at lookup time.
(function wrapI18n () {
    if ( typeof window.i18n !== 'function' || window.i18n.__unifyBranded ) {
        // i18n.js may load after this file: try again once it exists.
        if ( ! window.i18n ) setTimeout(wrapI18n, 0);
        return;
    }
    const original = window.i18n;
    window.i18n = function (...args) {
        const key = args[0];
        // "Powered by Puter.js" (Puter's docs): nothing to say on our server.
        if ( brand() && key === 'powered_by_puter_js' ) return '';
        // The sign-up fine print links Puter's terms: ours, or none until we have them.
        if ( brand() && key === 'tos_fineprint' ) {
            const p = params();
            if ( !p.terms_url || !p.privacy_url ) return '';
            return rebrandText(original.apply(this, args))
                .replace(/https:\/\/puter\.com\/terms/g, p.terms_url)
                .replace(/https:\/\/puter\.com\/privacy/g, p.privacy_url);
        }
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
    const elements = root.querySelectorAll ? [root, ...root.querySelectorAll('[alt], [title], [aria-label], [style], img, a[href]')] : [];
    for ( const el of elements ) {
        if ( !el.getAttribute ) continue;
        if ( el.tagName === 'A' ) {
            const to = linkFor(el.getAttribute('href'));
            // Only when it differs: setting href fires this observer again.
            if ( to === '' ) {
                if ( el.style.display !== 'none' ) el.style.display = 'none';
            }
            else if ( to && el.getAttribute('href') !== to ) el.setAttribute('href', to);
        }
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
        attributes: true, attributeFilter: ['alt', 'title', 'aria-label', 'style', 'src', 'href'],
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

// 4. Menus: no "Developer" / "Developers" item (Puter's developer site, added
//    by the user menu and the dashboard's). Puter's own extension adds its
//    item to the list in the same event, before or after this one: the list
//    is filtered now and whenever it is replaced.
const isDeveloperItem = (item) => item && typeof item === 'object' && (item.id === 'go_to_developer_site'
    || /developer\.puter\.com/.test(String(item.onClick || '') + String(item.action || '')));
window.addEventListener('ctxmenu-will-open', (event) => {
    const options = event.detail?.options;
    if ( !brand() || !options || !Array.isArray(options.items) ) return;
    const clean = (items) => {
        const kept = items.filter(item => !isDeveloperItem(item));
        // No separator left first, last or doubled by a removed item.
        return kept.filter((item, i) => item !== '-' || (i > 0 && i < kept.length - 1 && kept[i - 1] !== '-'));
    };
    let items = clean(options.items);
    Object.defineProperty(options, 'items', {
        configurable: true, enumerable: true,
        get: () => items,
        set: (v) => {
            items = Array.isArray(v) ? clean(v) : v;
        },
    });
});

// 5. Links opened from code (menus, buttons): the same destinations as links on
//    the page; one with none (Puter's developer site) does not open.
const openWindow = window.open;
window.open = function (url, ...rest) {
    const to = brand() && typeof url === 'string' ? linkFor(url) : null;
    if ( to === '' ) return null;
    return openWindow.call(this, to || url, ...rest);
};

console.debug('[unify] branding extension loaded');
