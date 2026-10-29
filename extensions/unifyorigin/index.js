/**
 * Keep the desktop's puter.js on this server from its first line.
 *
 * The desktop page loads puter.js, which starts with puter.com as its server
 * (api.puter.com) and opens its live socket there at once, before the
 * desktop's own setup points it at this server a moment later. Nothing is
 * sent, but every desktop load reached out to puter.com. puter.js reads two
 * page globals before its built-in default, PUTER_API_ORIGIN and
 * PUTER_ORIGIN; this sets them at the top of the page's <head>, from the
 * same values the desktop itself is given (config.json "api_base_url" and
 * the origin of the request).
 */
const { extension } = require('@heyputer/backend/src/extensions');

const json = (value) => JSON.stringify(String(value)).replace(/</g, '\\u003c');

extension.on('puter.gui.addons', (_key, event) => {
  const api = event.guiParams?.api_origin || event.guiParams?.api_base_url;
  const gui = event.guiParams?.gui_origin;
  if (!api) return;
  event.prependHeadContent = `<script>window.PUTER_API_ORIGIN=${json(api)};${gui ? `window.PUTER_ORIGIN=${json(gui)};` : ''}</script>\n${event.prependHeadContent || ''}`;
});
