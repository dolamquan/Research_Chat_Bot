import { describe, expect, it } from "vitest";

import { buildFieldGroups, collectArguments, fieldKey, initialValues } from "../schemaFields";

// Shaped like the catalog's schema for an api.* route: grouped path/query/body,
// with the body pointing at a Pydantic model through a local $ref.
const API_SCHEMA = {
  type: "object",
  properties: {
    path: { type: "object", properties: { note_id: { type: "string" } }, required: ["note_id"] },
    query: { type: "object", properties: { limit: { type: "integer", default: 20 } } },
    body: { $ref: "#/components/schemas/NoteUpdateRequest" },
  },
  required: ["path"],
  components: {
    schemas: {
      NoteUpdateRequest: {
        type: "object",
        description: "Fields to change.",
        properties: {
          title: { anyOf: [{ type: "string" }, { type: "null" }], description: "New title" },
          pinned: { type: "boolean", default: false },
          kind: { type: "string", enum: ["note", "highlight"] },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
      },
    },
  },
};

describe("buildFieldGroups", () => {
  it("groups api.* arguments by path/query/body and resolves local refs", () => {
    const groups = buildFieldGroups(API_SCHEMA);
    expect(groups.map((g) => g.name)).toEqual(["path", "query", "body"]);
    const body = groups[2];
    expect(body.description).toBe("Fields to change.");
    expect(body.fields.map((f) => [f.label, f.kind, f.required])).toEqual([
      ["title", "string", true],
      ["pinned", "boolean", false],
      ["kind", "enum", false],
      ["tags", "json", false],
    ]);
    expect(body.fields[2].options).toEqual(["note", "highlight"]);
    expect(body.fields[0].description).toBe("New title");
  });

  it("puts top-level scalars first for flat tools", () => {
    const groups = buildFieldGroups({
      type: "object",
      properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1 } },
      required: ["query"],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBeNull();
    expect(groups[0].fields.map((f) => f.label)).toEqual(["query", "limit"]);
  });

  it("falls back to one JSON field when a tool declares no properties", () => {
    for (const schema of [undefined, {}, { type: "object" }]) {
      const groups = buildFieldGroups(schema);
      expect(groups).toEqual([{ name: null, fields: [{ path: [], label: "arguments", kind: "json", required: false }] }]);
    }
  });
});

describe("initialValues", () => {
  it("prefills defaults and leaves the rest empty", () => {
    const groups = buildFieldGroups(API_SCHEMA);
    const values = initialValues(groups);
    expect(values["query.limit"]).toBe("20");
    expect(values["body.pinned"]).toBe(false);
    expect(values["body.title"]).toBe("");
  });
});

describe("collectArguments", () => {
  const groups = buildFieldGroups(API_SCHEMA);

  it("nests values under their group and coerces types", () => {
    const { args, errors } = collectArguments(groups, {
      "path.note_id": "n1",
      "query.limit": "5",
      "body.title": "  Renamed ",
      "body.pinned": true,
      "body.kind": "highlight",
      "body.tags": '["a", "b"]',
    });
    expect(errors).toEqual({});
    expect(args).toEqual({
      path: { note_id: "n1" },
      query: { limit: 5 },
      body: { title: "Renamed", pinned: true, kind: "highlight", tags: ["a", "b"] },
    });
  });

  it("omits blank optional fields instead of sending empty strings", () => {
    const { args, errors } = collectArguments(groups, {
      "path.note_id": "n1",
      "query.limit": "",
      "body.title": "t",
      "body.pinned": false,
      "body.kind": "",
      "body.tags": "",
    });
    expect(errors).toEqual({});
    expect(args).toEqual({ path: { note_id: "n1" }, body: { title: "t" } });
  });

  it("reports every problem against its field", () => {
    const { errors } = collectArguments(groups, {
      "path.note_id": "",
      "query.limit": "2.5",
      "body.title": "",
      "body.tags": "not json",
    });
    expect(errors).toEqual({
      "path.note_id": "required",
      "query.limit": "must be a whole number",
      "body.title": "required",
      "body.tags": "must be valid JSON",
    });
  });

  it("uses the whole-object JSON field when there is no schema", () => {
    const fallback = buildFieldGroups(undefined);
    const key = fieldKey(fallback[0].fields[0]);
    expect(key).toBe("$");
    expect(collectArguments(fallback, { $: '{"query": "graph rag"}' })).toEqual({
      args: { query: "graph rag" },
      errors: {},
    });
    expect(collectArguments(fallback, { $: "[1,2]" }).errors).toEqual({ $: "must be a JSON object" });
    expect(collectArguments(fallback, { $: "" }).args).toEqual({});
  });
});
