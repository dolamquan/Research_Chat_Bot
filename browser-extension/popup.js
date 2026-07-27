const DEFAULT_BACKEND = "http://127.0.0.1:8002";

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
};

let backendUrl = DEFAULT_BACKEND;

function setStatus(message, isError = false) {
  fields.status.textContent = message;
  fields.status.className = isError ? "error" : "";
  if (isError) {
    fields.success.hidden = true;
  }
}

function setSuccess(article) {
  const title = article?.article_title || article?.title || fields.title.value.trim() || "Paper";
  fields.successTitle.textContent = title;
  fields.success.hidden = false;
  fields.status.textContent = "Queued for indexing in the local database.";
  fields.status.className = "ok";
}

async function hydrateFromTab() {
  const stored = await chrome.storage.sync.get({
    backendUrl: DEFAULT_BACKEND,
    domain: "research",
  });
  backendUrl = (stored.backendUrl || DEFAULT_BACKEND).replace(/\/$/, "");
  fields.domain.value = stored.domain;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  fields.url.value = tab.url || "";
  fields.title.value = tab.title || "";
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
      domain: fields.domain.value.trim() || "research",
    });

    const response = await fetch(`${backend}/ingest/url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
      let detail = `${response.status} ${response.statusText}`;
      try {
        const body = await response.json();
        detail = body.detail || detail;
      } catch {
        // Keep the HTTP status when the backend response is not JSON.
      }
      throw new Error(detail);
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
