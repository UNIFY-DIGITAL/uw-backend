/**
 * Unify app switcher, and every app in its own browser tab.
 *
 * Bundled into the desktop at build time, like unify-branding.js (see
 * scripts/build-desktop.sh). Two things:
 *
 * 1. An apps button (the 9-dot grid) at the top of the screen, beside the
 *    desktop's own handle: on the desktop and over every open app, since apps
 *    run inside the desktop page. It opens a searchable panel of the person's
 *    apps: the organisation's (/unify/apps, the admin extension) without those
 *    they removed in the Dashboard's Apps tab; picking one opens it in a
 *    NEW TAB (/app/<name>), so switching apps is switching tabs.
 * 2. App tiles on the desktop (Apps and Home) open in a new tab too, instead
 *    of replacing the desktop in this one. Puter already does that for
 *    Ctrl/Cmd+click; this makes it the plain click. Folders, the "Add an app"
 *    tile, reorder mode and drags are left alone.
 *
 * Settings, in config.json "gui_params" (both on unless set to false):
 *   "unify_app_switcher": true    the apps button and panel
 *   "unify_apps_new_tab": true    desktop tiles open in a new tab
 */

import { REMOVED_APPS_KV_KEY, parseRemovedApps } from '../UI/Dashboard/removedApps.js';

const setting = (key) => (window.gui_params || {})[key] !== false;
const appUrl = (name) => `${location.origin}/app/${encodeURIComponent(name)}`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const signedIn = () => !!document.querySelector('.window-dashboard');

const GRID = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor">'
    + [5, 12, 19].map((y) => [5, 12, 19].map((x) => `<circle cx="${x}" cy="${y}" r="2.1"/>`).join('')).join('')
    + '</svg>';

const STYLE = `
#unify-apps-btn {
    position: fixed; top: 0; left: calc(50% + 34px); z-index: 2147483000;
    height: 20px; width: 34px; padding: 0; border: 0; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    border-radius: 0 0 10px 10px; color: #3b4250;
    background: rgba(255,255,255,.78); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    box-shadow: 0 1px 4px rgba(0,0,0,.18);
}
#unify-apps-btn:hover, #unify-apps-btn[aria-expanded="true"] { height: 26px; color: #1d4ed8; }
#unify-apps-btn:focus-visible { outline: 3px solid #93b4f5; outline-offset: 1px; }
#unify-apps-panel {
    position: fixed; top: 34px; left: 50%; transform: translateX(-50%); z-index: 2147483001;
    width: min(380px, calc(100vw - 24px)); max-height: min(560px, calc(100vh - 60px));
    display: flex; flex-direction: column; overflow: hidden;
    background: #fff; color: #1b1f24; border: 1px solid #e3e6ea; border-radius: 16px;
    box-shadow: 0 12px 40px rgba(0,0,0,.22); font: 14px/1.35 system-ui, -apple-system, "Segoe UI", sans-serif;
}
#unify-apps-panel[hidden] { display: none; }
#unify-apps-panel input {
    margin: 14px 14px 6px; padding: 9px 12px; font: inherit; color: inherit; background: #f4f6f8;
    border: 1px solid #e3e6ea; border-radius: 10px; outline: none;
}
#unify-apps-panel input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px #c7d7fb; }
#unify-apps-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; padding: 8px 10px 12px; overflow-y: auto; }
#unify-apps-grid a {
    display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 12px 4px;
    border-radius: 12px; color: inherit; text-decoration: none; text-align: center;
}
#unify-apps-grid a:hover, #unify-apps-grid a:focus-visible { background: #eef2fb; outline: none; }
#unify-apps-grid img { width: 44px; height: 44px; border-radius: 10px; object-fit: contain; }
#unify-apps-grid span { font-size: 12.5px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#unify-apps-panel .unify-apps-empty { grid-column: 1 / -1; text-align: center; color: #667080; padding: 24px 0; }
#unify-apps-panel .unify-apps-hint { padding: 0 14px 12px; color: #667080; font-size: 12px; }
@media (prefers-color-scheme: dark) {
    #unify-apps-btn { background: rgba(30,34,40,.8); color: #d6dbe3; }
    #unify-apps-btn:hover, #unify-apps-btn[aria-expanded="true"] { color: #8fb3ff; }
    #unify-apps-panel { background: #1a1e24; color: #e6e9ee; border-color: #2a3038; }
    #unify-apps-panel input { background: #111418; border-color: #2a3038; }
    #unify-apps-grid a:hover, #unify-apps-grid a:focus-visible { background: #243048; }
}
`;

// ---------------------------------------------------------------- the app list

let apps = null;      // [{ name, title, icon }]
let loading = null;

async function loadApps () {
    const auth = { Authorization: `Bearer ${window.auth_token || window.puter?.authToken}` };
    // The organisation's apps (admin extension): what an administrator turned
    // off, or kept for administrators, is not offered.
    const res = await fetch(`${window.api_origin}/unify/apps`, { headers: auth, cache: 'no-store' });
    if ( res.ok ) {
        const { apps: list } = await res.json();
        // The person's own list: apps they removed in the Dashboard's Apps tab
        // stay out (opening one from App Center puts it back there, and here).
        let removed = new Set();
        try {
            removed = parseRemovedApps(await window.puter.kv.get(REMOVED_APPS_KV_KEY));
        } catch {
            /* unreadable: show every app rather than none */
        }
        return list.filter((a) => ! removed.has(a.name))
            .map((a) => ({ name: a.name, title: a.title || a.name, icon: a.icon || window.icons?.['app.svg'] || '' }))
            .sort((a, b) => a.title.localeCompare(b.title));
    }
    // Without the admin extension: every app this account has.
    const all = [];
    for ( let page = 1; page <= 20; page++ ) {
        const r = await fetch(`${window.api_origin}/installedApps?orderBy=name&limit=100&page=${page}`, { headers: auth });
        const batch = await r.json();
        if ( ! Array.isArray(batch) ) throw new Error(`installedApps: ${r.status}`);
        if ( batch.length === 0 ) break;
        all.push(...batch);
        if ( batch.length < 100 ) break;
    }
    return all
        .filter((a) => a && a.name)
        .map((a) => ({ name: a.name, title: a.title || a.name, icon: a.iconUrl || a.icon || window.icons?.['app.svg'] || '' }))
        .sort((a, b) => a.title.localeCompare(b.title));
}

function refreshApps () {
    loading = loadApps().then((list) => { apps = list; }).catch((e) => {
        console.warn('[unify-apps] could not list apps:', e);
    }).finally(() => { loading = null; });
    return loading;
}

// ---------------------------------------------------------------- button + panel

let btn, panel, search, grid;

function render () {
    const q = search.value.trim().toLowerCase();
    if ( ! apps ) {
        grid.innerHTML = `<div class="unify-apps-empty">${loading ? 'Loading apps…' : 'Apps could not be listed.'}</div>`;
        return;
    }
    const shown = apps.filter((a) => ! q || a.title.toLowerCase().includes(q) || a.name.toLowerCase().includes(q));
    grid.innerHTML = shown.length
        ? shown.map((a) => `<a href="${esc(appUrl(a.name))}" target="_blank" rel="noopener" data-app="${esc(a.name)}" title="Open ${esc(a.title)} in a new tab">
            <img src="${esc(a.icon)}" alt="" draggable="false"><span>${esc(a.title)}</span></a>`).join('')
        : '<div class="unify-apps-empty">No app matches.</div>';
}

function open () {
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    search.value = '';
    render();
    if ( ! apps && ! loading ) refreshApps().then(render);
    else if ( loading ) loading.then(render);
    else refreshApps().then(render); // pick up apps added since; the old list shows meanwhile
    setTimeout(() => search.focus(), 0);
}

function close (refocus = false) {
    if ( panel.hidden ) return;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if ( refocus ) btn.focus();
}

function mount () {
    const style = document.createElement('style');
    style.textContent = STYLE;
    document.head.append(style);

    btn = document.createElement('button');
    btn.id = 'unify-apps-btn';
    btn.type = 'button';
    btn.title = 'All apps';
    btn.setAttribute('aria-label', 'All apps');
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', 'unify-apps-panel');
    btn.innerHTML = GRID;
    btn.hidden = true;
    btn.addEventListener('click', () => (panel.hidden ? open() : close()));

    panel = document.createElement('div');
    panel.id = 'unify-apps-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'All apps');
    panel.hidden = true;
    panel.innerHTML = '<input type="search" placeholder="Search apps" aria-label="Search apps" autocomplete="off">'
        + '<div id="unify-apps-grid"></div><div class="unify-apps-hint">Each app opens in a new tab.</div>';
    search = panel.querySelector('input');
    grid = panel.querySelector('#unify-apps-grid');
    search.addEventListener('input', render);
    search.addEventListener('keydown', (e) => {
        // Enter opens the first match, as a search box should.
        if ( e.key === 'Enter' ) {
            const first = grid.querySelector('a');
            if ( first ) { e.preventDefault(); window.open(first.href, '_blank', 'noopener'); close(); }
        }
    });
    grid.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if ( ! a ) return;
        // Ctrl/Cmd/middle click keep the browser's own handling (background tab).
        if ( e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey ) return;
        // Opened here, then the panel closes: hiding it first would cancel the link.
        e.preventDefault();
        window.open(a.href, '_blank', 'noopener');
        close();
    });
    panel.addEventListener('keydown', (e) => { if ( e.key === 'Escape' ) { e.stopPropagation(); close(true); } });
    let pressedInside = 0;
    document.addEventListener('pointerdown', (e) => {
        if ( panel.contains(e.target) || btn.contains(e.target) ) { pressedInside = Date.now(); return; }
        if ( ! panel.hidden ) close();
    }, true);
    // A click inside an app's frame never reaches this page; the page losing
    // focus to it does. But the desktop also hands focus to the app's frame on
    // any press, ours included: that one is not leaving.
    window.addEventListener('blur', () => { if ( Date.now() - pressedInside > 500 ) close(); });

    document.body.append(btn, panel);
    // Only for a signed-in desktop: not on the sign-in screen.
    const sync = () => {
        const show = signedIn();
        if ( btn.hidden === show ) btn.hidden = ! show;
        if ( ! show ) close();
    };
    sync();
    setInterval(sync, 1000);
}

// ---------------------------------------------------------------- tiles in new tabs

function newTabTiles () {
    let down = null;
    document.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; }, true);
    document.addEventListener('click', (e) => {
        if ( e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey ) return; // Puter's own handling stays for those
        const tile = e.target.closest?.('.myapps-tile, .bento-recent-app');
        if ( ! tile ) return;
        if ( tile.classList.contains('myapps-add-tile') || tile.dataset.groupId ) return;
        if ( tile.closest('.myapps-reorder-mode') ) return;
        if ( e.target.closest('.myapps-tile-remove') ) return;
        if ( down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 ) return; // the end of a drag
        if ( (e.detail ?? 0) > 1 ) return; // second click of a double-click
        const name = tile.dataset.appName;
        if ( ! name ) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        const link = tile.dataset.targetLink;
        window.open(link ? link : appUrl(name), '_blank', 'noopener');
    }, true);
}

function start () {
    if ( setting('unify_app_switcher') ) mount();
    if ( setting('unify_apps_new_tab') ) newTabTiles();
}

if ( document.readyState === 'loading' ) document.addEventListener('DOMContentLoaded', start);
else start();
