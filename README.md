# SiteAudit

SiteAudit is a headless browser tool built by **VibeCode Labs** that scans a website for common compliance risks for EU local businesses.

It loads the page in headless Chrome (Puppeteer), so JavaScript-heavy sites are checked as visitors actually see them, then runs three checks:

| Check | Risk when |
|-------|-----------|
| GDPR | The page loads Google Fonts from `fonts.googleapis.com` / `fonts.gstatic.com` (shares visitor IPs with Google) |
| Legal | No link with the text "Privacy Policy", "Privacybeleid", "Terms of Service" or "Algemene Voorwaarden" |
| Mobile | No `<meta name="viewport">` tag in `<head>` |

Results can be printed or saved as a PDF report from the browser.

## Run it

Requires Node.js 18+.

```bash
npm install
node server.js
```

Open http://localhost:3000, enter a URL and click **Scan website**.

If Chrome wasn't downloaded during install, run `npx puppeteer browsers install chrome-headless-shell`.

## API

`POST /api/scan` with `{ "url": "example.com" }` returns:

```json
{ "url": "https://example.com/", "gdprRisk": false, "missingPrivacy": true, "missingViewport": false }
```

## Limitations

- Only the homepage is scanned.
- Each scan launches a fresh browser, so scans take a few seconds.
- The server fetches any URL it is given. Do not expose it publicly without blocking private/internal addresses.

© VibeCode Labs · hello@vibecodelabs.be
