/**
 * A tool's JSON input schema, turned into form fields and back.
 *
 * The catalog describes every tool by its `input_schema`. For `api.*` tools
 * that schema is grouped — `{path, query, body}`, each an object of its own —
 * because the call is routed back through the real FastAPI route. Scalars
 * and enums become inputs; anything the form cannot express faithfully
 * (arrays, nested objects, unions) stays a JSON field rather than being
 * flattened into something that looks editable but is not.
 */

export type FieldKind = "string" | "number" | "integer" | "boolean" | "enum" | "json";

export type Field = {
  /** Where the value lands in the arguments object; `[]` means the whole object. */
  path: string[];
  label: string;
  kind: FieldKind;
  required: boolean;
  description?: string;
  options?: string[];
  defaultValue?: unknown;
};

export type FieldGroup = {
  /** `null` for top-level scalars; otherwise the grouping property (`body`, …). */
  name: string | null;
  description?: string;
  fields: Field[];
};

export type Schema = Record<string, unknown>;
export type FormValues = Record<string, string | boolean>;

const isObject = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Follow a local `$ref` (the catalog attaches only the definitions a tool uses). */
export function resolveRef(node: Schema, root: Schema): Schema {
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  let cursor: unknown = root;
  for (const segment of ref.slice(2).split("/")) {
    if (!isObject(cursor)) return node;
    cursor = cursor[segment];
  }
  return isObject(cursor) ? { ...cursor, ...withoutRef(node) } : node;
}

function withoutRef(node: Schema): Schema {
  const { $ref: _ref, ...rest } = node;
  return rest;
}

function schemaType(node: Schema): string | undefined {
  const type = node.type;
  if (typeof type === "string") return type;
  if (Array.isArray(type)) return type.find((t) => t !== "null") as string | undefined;
  // `anyOf: [{type: "string"}, {type: "null"}]` is how Pydantic spells `str | None`.
  const anyOf = node.anyOf;
  if (Array.isArray(anyOf)) {
    const members = anyOf.filter((m): m is Schema => isObject(m) && m.type !== "null");
    if (members.length === 1) return schemaType(members[0]);
  }
  return undefined;
}

function kindOf(node: Schema): FieldKind {
  if (Array.isArray(node.enum) && node.enum.every((v) => typeof v === "string")) return "enum";
  switch (schemaType(node)) {
    case "string":
      return "string";
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "json";
  }
}

function fieldFrom(name: string, node: Schema, path: string[], required: boolean): Field {
  const kind = kindOf(node);
  return {
    path,
    label: name,
    kind,
    required,
    description: typeof node.description === "string" ? node.description : undefined,
    options: kind === "enum" ? (node.enum as string[]) : undefined,
    defaultValue: node.default,
  };
}

function fieldsOf(node: Schema, root: Schema, prefix: string[]): Field[] {
  const properties = isObject(node.properties) ? node.properties : {};
  const required = new Set(Array.isArray(node.required) ? (node.required as string[]) : []);
  return Object.entries(properties).map(([name, raw]) => {
    const child = isObject(raw) ? resolveRef(raw, root) : {};
    return fieldFrom(name, child, [...prefix, name], required.has(name));
  });
}

/** The form for one tool. Always at least one group, so every tool can be run. */
export function buildFieldGroups(schema: Schema | undefined): FieldGroup[] {
  const root = schema ?? {};
  const resolved = resolveRef(root, root);
  const properties = isObject(resolved.properties) ? resolved.properties : null;
  if (!properties || Object.keys(properties).length === 0) {
    return [{ name: null, fields: [{ path: [], label: "arguments", kind: "json", required: false }] }];
  }

  const required = new Set(Array.isArray(resolved.required) ? (resolved.required as string[]) : []);
  const scalars: Field[] = [];
  const groups: FieldGroup[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    const node = isObject(raw) ? resolveRef(raw, root) : {};
    const nested = isObject(node.properties) && schemaType(node) !== "string";
    if (nested) {
      groups.push({
        name,
        description: typeof node.description === "string" ? node.description : undefined,
        fields: fieldsOf(node, root, [name]),
      });
    } else {
      scalars.push(fieldFrom(name, node, [name], required.has(name)));
    }
  }
  return [...(scalars.length ? [{ name: null, fields: scalars }] : []), ...groups];
}

export function fieldKey(field: Field): string {
  return field.path.length ? field.path.join(".") : "$";
}

export function initialValues(groups: FieldGroup[]): FormValues {
  const values: FormValues = {};
  for (const group of groups) {
    for (const field of group.fields) {
      const key = fieldKey(field);
      if (field.kind === "boolean") values[key] = field.defaultValue === true;
      else if (field.defaultValue === undefined || field.defaultValue === null) values[key] = "";
      else if (field.kind === "json") values[key] = JSON.stringify(field.defaultValue, null, 2);
      else values[key] = String(field.defaultValue);
    }
  }
  return values;
}

function setPath(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor = target;
  path.slice(0, -1).forEach((segment) => {
    if (!isObject(cursor[segment])) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  });
  cursor[path[path.length - 1]] = value;
}

/**
 * Coerce what the user typed into the arguments the tool expects.
 *
 * Optional fields left blank are omitted, not sent as empty strings — a
 * `limit=""` would fail the route's own validation for no reason. Every
 * problem is reported against its field so nothing is silently dropped.
 */
export function collectArguments(
  groups: FieldGroup[],
  values: FormValues,
): { args: Record<string, unknown>; errors: Record<string, string> } {
  const args: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  for (const group of groups) {
    for (const field of group.fields) {
      const key = fieldKey(field);
      const raw = values[key];

      if (field.kind === "boolean") {
        if (raw === true || field.required) setPath(args, field.path, raw === true);
        continue;
      }

      const text = typeof raw === "string" ? raw.trim() : "";
      if (!text) {
        if (field.required) errors[key] = "required";
        continue;
      }

      if (field.kind === "number" || field.kind === "integer") {
        const parsed = Number(text);
        if (!Number.isFinite(parsed)) errors[key] = "must be a number";
        else if (field.kind === "integer" && !Number.isInteger(parsed)) errors[key] = "must be a whole number";
        else setPath(args, field.path, parsed);
        continue;
      }

      if (field.kind === "json") {
        try {
          const parsed: unknown = JSON.parse(text);
          if (field.path.length === 0) {
            if (!isObject(parsed)) errors[key] = "must be a JSON object";
            else Object.assign(args, parsed);
          } else {
            setPath(args, field.path, parsed);
          }
        } catch {
          errors[key] = "must be valid JSON";
        }
        continue;
      }

      setPath(args, field.path, text);
    }
  }

  return { args, errors };
}
