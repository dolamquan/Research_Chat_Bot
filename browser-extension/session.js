/**
 * Finding the signed-in Zoetrope session from the web app.
 *
 * The extension deliberately holds no credentials of its own. supabase-js
 * persists the session in the app's `localStorage` under a key of the shape
 * `sb-<project ref>-auth-token`, so the extension reads that entry out of an
 * open app tab and sends the access token as a bearer.
 *
 * It also cannot refresh a token: refreshing needs the project's publishable
 * key, which lives in the app, not here. An expired token is therefore
 * reported as "reopen the app", where supabase-js refreshes it on its own.
 *
 * Everything in this file is pure so it can be tested without a browser; the
 * chrome.* calls live in popup.js.
 */

/** supabase-js keys its session `sb-<project ref>-auth-token`. */
export const SUPABASE_KEY_PATTERN = /^sb-.+-auth-token$/;

/**
 * Pick the Supabase session out of a snapshot of localStorage.
 *
 * @param {Record<string, string>} entries localStorage as a plain object.
 * @returns {{access_token: string, expires_at: number|null} | null}
 */
export function readSession(entries) {
  for (const [key, raw] of Object.entries(entries || {})) {
    if (!SUPABASE_KEY_PATTERN.test(key)) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A key that matches the shape but holds something else is not ours.
      continue;
    }
    // supabase-js has stored the session both bare and wrapped in
    // `currentSession` across versions; accept either.
    const session = parsed?.currentSession ?? parsed;
    const accessToken = session?.access_token;
    if (typeof accessToken !== "string" || !accessToken) continue;
    const expiresAt = typeof session.expires_at === "number" ? session.expires_at : null;
    return { access_token: accessToken, expires_at: expiresAt };
  }
  return null;
}

/**
 * Is this session still usable?
 *
 * `expires_at` is a UNIX time in seconds. A small skew allowance stops the
 * extension sending a token that dies in transit.
 */
export function isExpired(session, nowMs = Date.now(), skewSeconds = 30) {
  if (!session || typeof session.expires_at !== "number") return false;
  return session.expires_at - skewSeconds <= Math.floor(nowMs / 1000);
}

/** The origins an app tab may be served from, given the configured app URL. */
export function appOriginPatterns(appUrl) {
  let origin;
  try {
    origin = new URL(appUrl).origin;
  } catch {
    return [];
  }
  const patterns = [`${origin}/*`];
  // 127.0.0.1 and localhost are the same server but different storage origins,
  // so the session may sit under whichever one the user signed in on.
  try {
    const url = new URL(origin);
    const twin = url.hostname === "127.0.0.1" ? "localhost" : url.hostname === "localhost" ? "127.0.0.1" : null;
    if (twin) {
      url.hostname = twin;
      patterns.push(`${url.origin}/*`);
    }
  } catch {
    // Keep the single pattern.
  }
  return patterns;
}

/**
 * Turn a failed ingest response into something worth showing a user.
 *
 * 401 is the case this whole file exists for, so it gets an instruction
 * rather than a status code.
 */
export function describeFailure(status, detail) {
  if (status === 401) {
    return "Sign in to Zoetrope in a browser tab, then try again.";
  }
  if (status === 403) {
    return detail || "This account is not allowed to add papers.";
  }
  if (status === 503) {
    return detail || "Zoetrope is running without authentication configured.";
  }
  return detail || `Request failed (${status}).`;
}

/** The Authorization header for a token, or no header at all. */
export function authHeaders(accessToken) {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}
