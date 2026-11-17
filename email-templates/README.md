# Email wording

Our text for the emails the server sends, in place of Puter's. One file per email,
named after Puter's template (the list: `vendor/puter/src/backend/clients/email/templates.ts`):

- `<name>.html`: first line `Subject: ...`, then the HTML body.
- `<name>.txt`: the plain-text version (optional; shown by mail apps that do not show HTML).

Filled in for you: `{{brand}}` (BRAND_NAME), `{{support}}` (SUPPORT_EMAIL), `{{minutes}}`
(how long a code lasts, EMAIL_CODE_MINUTES, 10 by default), plus Puter's own values for
that email, such as `{{code}}`. An email with no file here keeps Puter's text, with our
brand and support address.

After a change: `scripts/configure.sh && docker compose restart puter`.
