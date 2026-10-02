import { describe, expect, it } from "vitest";

import {
  articleInitialMessage,
  articleTitle,
  citationTitle,
  clamp,
  contextLabel,
  documentFromArticle,
  initialMessage,
  isPaperSource,
  jobStatusLabel,
  jobTitle,
  paperSourceKey,
  paperSubtitle,
  paperTitle,
  scopeLabelFor,
  sourceCitationLabel,
  sourceKey,
  sourceTextValue,
  titleFromSource,
} from "./appHelpers";
import type { Article, IngestionJob, Source } from "./types";

const article: Article = {
  article_id: "a1",
  title: "Dense Passage Retrieval",
  source: "2004.04906v3_dense_passage_retrieval.pdf",
  domain: "nlp",
  category: "retrieval",
  tags: ["rag"],
  status: "indexed",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
};

const job: IngestionJob = {
  job_id: "j1",
  url: "https://arxiv.org/pdf/2401.00001_graph_rag.pdf",
  domain: "nlp",
  category: "retrieval",
  tags: [],
  status: "queued",
  stage: "",
  message: "",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
};

describe("titleFromSource", () => {
  it("strips the arXiv id, the extension and the separators", () => {
    expect(titleFromSource("2004.04906v3_dense_passage_retrieval.pdf")).toBe(
      "dense passage retrieval",
    );
    expect(titleFromSource("2401.12345_graph-rag.PDF")).toBe("graph rag");
  });

  it("leaves a plain name alone", () => {
    expect(titleFromSource("notes")).toBe("notes");
  });
});

describe("articleTitle", () => {
  it("prefers the stored title", () => {
    expect(articleTitle(article)).toBe("Dense Passage Retrieval");
  });

  it("falls back to the filename when the title is empty", () => {
    expect(articleTitle({ ...article, title: "" })).toBe("dense passage retrieval");
  });
});

describe("sourceTextValue", () => {
  it("passes strings through and treats anything else as absent", () => {
    expect(sourceTextValue("text")).toBe("text");
    expect(sourceTextValue(undefined)).toBe("");
    expect(sourceTextValue(42)).toBe("");
    expect(sourceTextValue(null)).toBe("");
    expect(sourceTextValue({ toString: () => "nope" })).toBe("");
  });
});

describe("sourceKey", () => {
  it("separates two passages from the same page of the same paper", () => {
    const base: Source = { id: "s1", source: "paper.pdf", page: 3 };
    expect(sourceKey({ ...base, text: "first passage" })).not.toBe(
      sourceKey({ ...base, text: "second passage" }),
    );
  });

  it("is stable for the same passage", () => {
    const source: Source = { id: "s1", source: "paper.pdf", page: 3, text: "abc" };
    expect(sourceKey(source)).toBe(sourceKey({ ...source }));
  });

  it("only considers the first 100 characters of the text", () => {
    const prefix = "x".repeat(100);
    const a: Source = { id: "s1", source: "p.pdf", page: 1, text: `${prefix}one` };
    const b: Source = { id: "s1", source: "p.pdf", page: 1, text: `${prefix}two` };
    expect(sourceKey(a)).toBe(sourceKey(b));
  });

  it("does not throw on a source with nothing in it", () => {
    expect(() => sourceKey({} as Source)).not.toThrow();
  });
});

describe("scopeLabelFor", () => {
  it("names whichever part of the scope is set", () => {
    expect(scopeLabelFor("nlp", "retrieval")).toBe("nlp / retrieval");
    expect(scopeLabelFor("nlp", "")).toBe("nlp");
    expect(scopeLabelFor("", "retrieval")).toBe("retrieval");
    expect(scopeLabelFor("", "")).toBe("all papers");
  });
});

describe("clamp", () => {
  it("holds a value inside the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(99, 0, 10)).toBe(10);
  });
});

describe("jobStatusLabel", () => {
  it("distinguishes the two stages of a running job", () => {
    expect(jobStatusLabel({ ...job, status: "running", stage: "downloading" })).toBe("Downloading");
    expect(jobStatusLabel({ ...job, status: "running", stage: "embedding" })).toBe("Indexing");
  });

  it("labels the terminal states", () => {
    expect(jobStatusLabel({ ...job, status: "queued" })).toBe("Queued");
    expect(jobStatusLabel({ ...job, status: "indexed" })).toBe("Indexed");
    expect(jobStatusLabel({ ...job, status: "failed" })).toBe("Failed");
  });

  it("shows an unrecognised status rather than hiding it", () => {
    expect(jobStatusLabel({ ...job, status: "paused" })).toBe("paused");
  });
});

describe("jobTitle", () => {
  it("prefers the indexed article's title, then the requested one, then the URL", () => {
    expect(jobTitle({ ...job, article_title: "Graph RAG", title: "requested" })).toBe("Graph RAG");
    expect(jobTitle({ ...job, article_title: null, title: "requested" })).toBe("requested");
    // The arXiv-id strip is anchored to the start of the string, so a full URL
    // keeps its id: this is a placeholder until the job has a real title.
    expect(jobTitle(job)).toBe("https://arxiv.org/pdf/2401.00001 graph rag");
  });
});

describe("documentFromArticle", () => {
  it("places a library article off the map, with no cluster of its own", () => {
    const document = documentFromArticle(article);
    expect(document).toMatchObject({
      article_id: "a1",
      cluster_id: -1,
      cluster_label: "retrieval",
      chunk_count: 0,
      x: 0,
      y: 0,
    });
  });

  it("labels it by domain, then a constant, when there is no category", () => {
    expect(documentFromArticle({ ...article, category: "" }).cluster_label).toBe("nlp");
    expect(documentFromArticle({ ...article, category: "", domain: "" }).cluster_label).toBe(
      "Library",
    );
  });
});

describe("contextLabel", () => {
  it("names a figure, with its page when known", () => {
    expect(contextLabel({ document_type: "visual_asset", page: 4 }, 0)).toBe("Figure/image - p.4");
    expect(contextLabel({ image_url: "/figures/1.png" }, 0)).toBe("Figure/image");
  });

  it("names a PDF selection", () => {
    expect(contextLabel({ selection: true, page: 2 }, 0)).toBe("PDF selection - p.2");
    expect(contextLabel({ selection: true }, 0)).toBe("PDF selection");
  });

  it("falls back through title, filename, then the position", () => {
    expect(contextLabel({ title: "Method" }, 0)).toBe("Method");
    expect(contextLabel({ source: "paper.pdf" }, 0)).toBe("paper.pdf");
    expect(contextLabel({}, 2)).toBe("Context 3");
  });
});

describe("sourceCitationLabel", () => {
  it("cites a page when there is one, otherwise the position", () => {
    expect(sourceCitationLabel({ page: 7 }, 0)).toBe("[p.7]");
    expect(sourceCitationLabel({}, 0)).toBe("[1]");
  });
});

describe("citationTitle", () => {
  it("falls back through title, filename, then a default", () => {
    expect(citationTitle({ title: "Method", source: "p.pdf" })).toBe("Method");
    expect(citationTitle({ source: "p.pdf" })).toBe("p.pdf");
    expect(citationTitle({})).toBe("Open source");
  });
});

describe("isPaperSource", () => {
  it("accepts a whole indexed paper", () => {
    expect(isPaperSource({ source: "paper.pdf" })).toBe(true);
  });

  it("rejects selections and figures, which are not papers to open", () => {
    expect(isPaperSource({ source: "paper.pdf", selection: true })).toBe(false);
    expect(isPaperSource({ source: "paper.pdf", document_type: "visual_asset" })).toBe(false);
    expect(isPaperSource({ source: "paper.pdf", image_url: "/f.png" })).toBe(false);
  });

  it("rejects anything without a filename", () => {
    expect(isPaperSource({ source: "" })).toBe(false);
    expect(isPaperSource({} as Source)).toBe(false);
    expect(isPaperSource(null as unknown as Source)).toBe(false);
  });
});

describe("paperSourceKey", () => {
  it("prefers the article id, then the filename, then the chunk id", () => {
    expect(paperSourceKey({ article_id: "a1", source: "p.pdf", id: 9 })).toBe("a1");
    expect(paperSourceKey({ source: "p.pdf", id: 9 })).toBe("p.pdf");
    expect(paperSourceKey({ id: 9 })).toBe("9");
    expect(paperSourceKey({})).toBe("");
  });
});

describe("paperTitle and paperSubtitle", () => {
  it("titles a paper by its stored title, then its filename", () => {
    expect(paperTitle({ title: "Graph RAG" })).toBe("Graph RAG");
    expect(paperTitle({ source: "2401.00001_graph_rag.pdf" })).toBe("graph rag");
    expect(paperTitle({})).toBe("Indexed paper");
  });

  it("joins only the parts of the subtitle that exist", () => {
    expect(paperSubtitle({ category: "retrieval", domain: "nlp" })).toBe("retrieval - nlp");
    expect(paperSubtitle({ domain: "nlp" })).toBe("nlp");
    expect(paperSubtitle({})).toBe("");
  });
});

describe("welcome messages", () => {
  it("scopes the greeting to a cluster when one is selected", () => {
    const message = initialMessage({
      cluster_id: 3,
      cluster_label: "Retrieval",
      document_count: 12,
    });
    expect(message.id).toBe("welcome-3");
    expect(message.content).toContain("Retrieval");
    expect(message.synthetic).toBe(true);
  });

  it("greets across the whole library when nothing is selected", () => {
    const message = initialMessage();
    expect(message.id).toBe("welcome-all");
    expect(message.content).toContain("Zoetrope");
  });

  it("marks the article greeting synthetic so it never re-enters the model's history", () => {
    const message = articleInitialMessage(article);
    expect(message.synthetic).toBe(true);
    expect(message.role).toBe("assistant");
    expect(message.content).toContain("Dense Passage Retrieval");
  });
});
