# Zoetrope Paper Capture

A small unpacked browser extension for adding the current arXiv or PDF page to
your Zoetrope library.

## Load It

1. Start the backend on `http://127.0.0.1:8002`.
2. Open Chrome or Edge.
3. Go to `chrome://extensions` or `edge://extensions`.
4. Turn on Developer mode.
5. Choose **Load unpacked**.
6. Select this `browser-extension` folder.

## Sign In

The extension holds no credentials of its own. It reads the session from an
open Zoetrope tab and sends that account's access token as a bearer, so the
paper is added to *your* library rather than rejected with a 401.

1. Open Zoetrope (`http://127.0.0.1:5173` by default) and sign in.
2. Leave that tab open.
3. The popup shows **Signed in to Zoetrope** when it can see the session.

If the popup says the session expired, reload the app tab — the app refreshes
its own token, which the extension then picks up. The extension cannot refresh
a token itself, because that needs the project's publishable key, which stays
in the app.

A backend running with `AUTH_MODE=disabled` accepts requests with no token at
all, so the extension still works in that setup without a signed-in tab.

## Use It

Open an arXiv abstract page, arXiv PDF page, or direct PDF URL. Click the
Zoetrope extension button, review the fields, then click **Add to database**.

The paper is indexed immediately for retrieval. Rebuild the topology after
adding papers if you want the new articles to appear on the map.

## Settings

Stored in `chrome.storage.sync`:

| Key | Default | What it is |
|---|---|---|
| `backendUrl` | `http://127.0.0.1:8002` | The API the paper is posted to |
| `appUrl` | `http://127.0.0.1:5173` | The app tab the session is read from |
| `domain` | `research` | The domain the last paper was filed under |

Pointing either at a host outside the manifest's `host_permissions` requires
granting the optional permission when the browser asks.

## Tests

The token handling in `session.js` is pure and covered by `session.test.ts`,
which runs with the frontend suite:

```bash
cd ../frontend
pnpm run test
```
