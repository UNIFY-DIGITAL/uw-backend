/**
 * Every window closes.
 *
 * Bundled into the desktop at build time, like unify-branding.js (see
 * scripts/build-desktop.sh).
 *
 * Closing the window of an app that uses Puter's SDK first asks the app
 * ("windowWillClose") and waits for its answer, with no time limit
 * (window.sendWindowWillCloseMsg, src/gui/src/helpers.js). The SDK answers at
 * once: "close" by default, "not yet" when the app wants to ask about unsaved
 * work first. An app whose SDK never answers keeps its window open for good:
 * Puter's own apps (Camera, Recorder, Editor, ...) load from puter.com, and
 * on this server their SDK does not reply. After CLOSE_WAIT_MS of silence the
 * window closes anyway; an app that answers is never overruled.
 */

const CLOSE_WAIT_MS = 2000;

function patch () {
    const ask = window.sendWindowWillCloseMsg;
    if ( typeof ask !== 'function' ) return false;
    if ( ask.unifyPatched ) return true;
    const askOrClose = (iframe) => new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ msg: true }), CLOSE_WAIT_MS);
        ask(iframe).then((answer) => { clearTimeout(timer); resolve(answer); });
    });
    askOrClose.unifyPatched = true;
    window.sendWindowWillCloseMsg = askOrClose;
    return true;
}

// helpers.js may define it after this runs.
if ( ! patch() ) {
    const timer = setInterval(() => { if ( patch() ) clearInterval(timer); }, 250);
    setTimeout(() => clearInterval(timer), 60000);
}
