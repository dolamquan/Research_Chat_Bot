import {
  appOriginPatterns,
  authHeaders,
  describeFailure,
  isExpired,
  readSession,
} from "./session.js";

const DEFAULT_BACKEND = "http://127.0.0.1:8002";
const DEFAULT_APP = "http://127.0.0.1:5173";

const fields = {
  url: document.querySelector("#url"),
  title: document.querySelector("#title"),
  domain: document.querySelector("#domain"),
  category: document.querySelector("#category"),
  tags: document.querySelector("#tags"),
  submit: document.querySelector("#submit"),
  success: document.querySelector("#success"),
  successTitle: document.querySelector("#success-title"),
  status: document.querySelector("#status"),
  account: document.querySelector("#account"),
};

let backendUrl = DEFAULT_BACKEND;
let appUrl = DEFAULT_APP;

function setStatus(message, isError = false) {
  fields.status.textContent = message;
  fields.status.className = isError ? "error" : "";
  if (isError) {
    fields.success.hidden = true;
  }
}

function setAccount(message, isError = false) {
  fields.account.textContent = message;
  fields.account.className = isError ? "account error" : "account";
}

function setSuccess(article) {
  const title = article?.article_title || article?.title || fields.title.value.trim() || "Paper";
  fields.successTitle.textContent = title;
  fields.success.hidden = false;
  fields.status.textContent = "Queued for indexing in the local database.";
  fields.status.className = "ok";
}

/**
 * Read the signed-in session out of an open Zoetrope tab.
 *
 * Returns `{ session }` when one was found, or `{ reason }` explaining what
 * the user has to do. A missing session is not fatal: a backend running with
 * `AUTH_MODE=disabled` accepts the request anyway, so the caller still tries.
 */
async function findSession() {
  const patterns = appOriginPatterns(appUrl);
  if (patterns.length === 0) {
    return { reason: "The Zoetrope app URL is not a valid address." };
  }

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: patterns });
  } catch {
    return { reason: "Allow this extension to read your Zoetrope tab, then try again." };
  }
  if (tabs.length === 0) {
    return { reason: `Open Zoetrope at ${appUrl} and sign in.` };
  }

  for (const tab of tabs) {
    let results;
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        // Runs in the page's own origin, which is the only place the session
        // is readable. It copies out the auth entry and nothing else.
        func: () => Object.fromEntries(Object.entries({ ...localStorage })),
      });
    } catch {
      continue;
    }
    const session = readSession(results?.[0]?.result || {});
    if (!session) continue;
    if (isExpired(session)) {
      return { reason: "Your Zoetrope session expired. Reload the app tab, then try again." };
    }
    return { session };
  }

  return { reason: `Sign in to Zoetrope at ${appUrl}.` };
}

async function hydrateFromTab() {
  const stored = await chrome.storage.sync.get({
    backendUrl: DEFAULT_BACKEND,
    appUrl: DEFAULT_APP,
    domain: "research",
  });
  backendUrl = (stored.backendUrl || DEFAULT_BACKEND).replace(/\/$/, "");
  appUrl = (stored.appUrl || DEFAULT_APP).replace(/\/$/, "");
  fields.domain.value = stored.domain;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    fields.url.value = tab.url || "";
    fields.title.value = tab.title || "";
  }

  const { session, reason } = await findSession();
  if (session) {
    setAccount("Signed in to Zoetrope.");
  } else {
    setAccount(reason, true);
  }
}

async function submitPaper() {
  const backend = backendUrl;
  const url = fields.url.value.trim();

  if (!url) {
    setStatus("Add a paper URL first.", true);
    return;
  }

  fields.submit.disabled = true;
  fields.success.hidden = true;
  setStatus("Indexing paper...");

  try {
    await chrome.storage.sync.set({
      backendUrl: backend,
      appUrl,
      domain: fields.domain.value.trim() || "research",
    });

    // A missing session is still worth attempting: the backend may be running
    // with AUTH_MODE=disabled. If it is not, the 401 below explains itself.
    const { session, reason } = await findSession();
    if (session) {
      setAccount("Signed in to Zoetrope.");
    } else {
      setAccount(reason, true);
    }

    const response = await fetch(`${backend}/ingest/url`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(session?.access_token),
      },
      body: JSON.stringify({
        url,
        title: fields.title.value.trim() || null,
        domain: fields.domain.value.trim() || "research",
        category: fields.category.value.trim() || "uncategorized",
        tags: fields.tags.value
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
      }),
    });

    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = body.detail || "";
      } catch {
        // Keep the HTTP status when the backend response is not JSON.
      }
      throw new Error(describeFailure(response.status, detail));
    }

    const result = await response.json();
    setSuccess(result.article || result.job);
  } catch (error) {
    setStatus(
      `Could not index paper: ${error instanceof Error ? error.message : "request failed"}`,
      true,
    );
  } finally {
    fields.submit.disabled = false;
  }
}

fields.submit.addEventListener("click", () => {
  void submitPaper();
});

void hydrateFromTab();
