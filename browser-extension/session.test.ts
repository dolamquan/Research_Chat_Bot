// `describe`/`it`/`expect` come from vitest's globals: this file sits outside
// the frontend package, so a bare `vitest` import would not resolve from here.
import {
  appOriginPatterns,
  authHeaders,
  describeFailure,
  isExpired,
  readSession,
} from "./session.js";

const token = "eyJhbGciOiJIUzI1NiJ9.payload.signature";

function stored(session: Record<string, unknown>, key = "sb-abcdefghijk-auth-token") {
  return { [key]: JSON.stringify(session) };
}

describe("readSession", () => {
  it("finds the access token supabase-js stored for the project", () => {
    const entries = stored({ access_token: token, expires_at: 2_000_000_000 });
    expect(readSession(entries)).toEqual({ access_token: token, expires_at: 2_000_000_000 });
  });

  it("accepts the older shape that wraps the session in currentSession", () => {
    const entries = stored({ currentSession: { access_token: token, expires_at: 42 } });
    expect(readSession(entries)).toEqual({ access_token: token, expires_at: 42 });
  });

  it("reports no expiry rather than inventing one when the entry omits it", () => {
    expect(readSession(stored({ access_token: token }))).toEqual({
      access_token: token,
      expires_at: null,
    });
  });

  it("ignores unrelated localStorage entries from the app", () => {
    const entries = {
      "researchmind.activeView": "chat",
      "sb-something": JSON.stringify({ access_token: token }),
      theme: "dark",
    };
    expect(readSession(entries)).toBeNull();
  });

  it("skips a matching key whose value is not the session", () => {
    expect(readSession({ "sb-abc-auth-token": "not json at all" })).toBeNull();
    expect(readSession(stored({ user: { id: "u1" } }))).toBeNull();
    expect(readSession(stored({ access_token: "" }))).toBeNull();
  });

  it("survives an empty or missing snapshot", () => {
    expect(readSession({})).toBeNull();
    expect(readSession(undefined as unknown as Record<string, string>)).toBeNull();
  });
});

describe("isExpired", () => {
  const now = 1_700_000_000_000; // ms
  const nowSeconds = now / 1000;

  it("treats a token that already lapsed as expired", () => {
    expect(isExpired({ access_token: token, expires_at: nowSeconds - 1 }, now)).toBe(true);
  });

  it("treats a token with time left as usable", () => {
    expect(isExpired({ access_token: token, expires_at: nowSeconds + 600 }, now)).toBe(false);
  });

  it("refuses a token that would die in transit", () => {
    // Inside the 30s skew allowance.
    expect(isExpired({ access_token: token, expires_at: nowSeconds + 10 }, now)).toBe(true);
  });

  it("cannot judge a session with no expiry, so it lets it through", () => {
    expect(isExpired({ access_token: token, expires_at: null }, now)).toBe(false);
    expect(isExpired(null, now)).toBe(false);
  });
});

describe("appOriginPatterns", () => {
  it("covers both loopback spellings, which are separate storage origins", () => {
    expect(appOriginPatterns("http://127.0.0.1:5173")).toEqual([
      "http://127.0.0.1:5173/*",
      "http://localhost:5173/*",
    ]);
    expect(appOriginPatterns("http://localhost:5173/")).toEqual([
      "http://localhost:5173/*",
      "http://127.0.0.1:5173/*",
    ]);
  });

  it("leaves a deployed host alone", () => {
    expect(appOriginPatterns("https://zoetrope.example.com/app")).toEqual([
      "https://zoetrope.example.com/*",
    ]);
  });

  it("returns nothing for an address it cannot parse", () => {
    expect(appOriginPatterns("not a url")).toEqual([]);
    expect(appOriginPatterns("")).toEqual([]);
  });
});

describe("describeFailure", () => {
  it("turns the 401 this feature exists for into an instruction", () => {
    expect(describeFailure(401, "Sign in required.")).toMatch(/Sign in to Zoetrope/);
  });

  it("passes the backend's own wording through for other failures", () => {
    expect(describeFailure(403, "Administrator access required.")).toBe(
      "Administrator access required.",
    );
    expect(describeFailure(500, "")).toBe("Request failed (500).");
  });
});

describe("authHeaders", () => {
  it("sends a bearer when there is a token", () => {
    expect(authHeaders(token)).toEqual({ Authorization: `Bearer ${token}` });
  });

  it("sends no header at all when there is none, so AUTH_MODE=disabled still works", () => {
    expect(authHeaders(undefined)).toEqual({});
    expect(authHeaders("")).toEqual({});
  });
});
