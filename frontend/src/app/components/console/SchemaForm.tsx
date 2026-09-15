import { useState } from "react";

import type { Field, FieldGroup, FormValues } from "./schemaFields";
import { fieldKey } from "./schemaFields";
import { groupLabel, humanLabel } from "./toolText";

/** Optional fields beyond this many are folded behind "More options". */
const OPTIONAL_VISIBLE = 3;

/**
 * Inputs generated from a tool's schema, in a person's words: labels from
 * field names, groups named for what they mean rather than which part of the
 * HTTP request they fill, required fields first and rarely-needed ones folded.
 * The field list, defaults and coercion live in `schemaFields.ts`.
 */
export function SchemaForm({
  groups,
  values,
  errors,
  disabled = false,
  onChange,
}: {
  groups: FieldGroup[];
  values: FormValues;
  errors: Record<string, string>;
  disabled?: boolean;
  onChange: (key: string, value: string | boolean) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const single = groups.length === 1;

  return (
    <div className="space-y-5">
      {groups.map((group) => {
        const heading = groupLabel(group.name);
        const required = group.fields.filter((field) => field.required);
        const optional = group.fields.filter((field) => !field.required);
        const key = group.name ?? "$";
        const foldOptional = optional.length > OPTIONAL_VISIBLE && !expanded.has(key);
        const shownOptional = foldOptional ? [] : optional;
        return (
          <fieldset key={key} className="min-w-0 space-y-3">
            {heading && !single ? (
              <legend className="mb-1 text-xs text-muted-foreground">
                {heading.label}
                {heading.hint ? <span className="ml-1.5">— {heading.hint}</span> : null}
              </legend>
            ) : null}
            {[...required, ...shownOptional].map((field) => (
              <FieldInput
                key={fieldKey(field)}
                field={field}
                value={values[fieldKey(field)]}
                error={errors[fieldKey(field)]}
                disabled={disabled}
                onChange={(value) => onChange(fieldKey(field), value)}
              />
            ))}
            {foldOptional ? (
              <button
                type="button"
                onClick={() => setExpanded((current) => new Set(current).add(key))}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                More options ({optional.length})
              </button>
            ) : null}
            {group.fields.length === 0 ? <p className="text-xs text-muted-foreground">Nothing to fill in.</p> : null}
          </fieldset>
        );
      })}
    </div>
  );
}

const inputClass =
  "w-full rounded border border-border bg-card px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60 disabled:opacity-50";

function typeHint(field: Field): string {
  switch (field.kind) {
    case "integer":
      return "a whole number";
    case "number":
      return "a number";
    case "json":
      return field.path.length === 0 ? "JSON object" : "JSON";
    default:
      return "";
  }
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function FieldInput({
  field,
  value,
  error,
  disabled,
  onChange,
}: {
  field: Field;
  value: string | boolean | undefined;
  error?: string;
  disabled: boolean;
  onChange: (value: string | boolean) => void;
}) {
  const id = `field-${fieldKey(field).replace(/[^a-z0-9]/gi, "-")}`;
  const title = humanLabel(field.label);
  const hint = field.description || typeHint(field);

  if (field.kind === "boolean") {
    return (
      <label htmlFor={id} className="flex items-start gap-2">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 h-3.5 w-3.5"
        />
        <span className="text-sm text-foreground">
          {title}
          {field.description ? <span className="block text-xs text-muted-foreground">{field.description}</span> : null}
        </span>
      </label>
    );
  }

  const text = typeof value === "string" ? value : "";
  return (
    <label htmlFor={id} className="block max-w-xl space-y-1">
      <span className="flex items-baseline gap-2">
        <span className="text-sm text-foreground">{title}</span>
        {field.required ? <span className="text-[11px] text-muted-foreground">required</span> : null}
      </span>
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
      {field.kind === "enum" ? (
        <select id={id} value={text} disabled={disabled} onChange={(event) => onChange(event.target.value)} className={inputClass}>
          <option value="">{field.required ? "Choose…" : "Leave unset"}</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : field.kind === "json" ? (
        <textarea
          id={id}
          value={text}
          rows={field.path.length === 0 ? 5 : 3}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.path.length === 0 ? '{"query": "…"}' : "[ … ]"}
          className={`${inputClass} resize-y font-mono text-xs`}
        />
      ) : (
        <input
          id={id}
          type={field.kind === "string" ? "text" : "number"}
          step={field.kind === "integer" ? 1 : "any"}
          value={text}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.required ? "" : "Optional"}
          className={inputClass}
        />
      )}
      {error ? (
        <span role="alert" className="block text-xs text-destructive">
          {error === "required" ? "This is required." : `${capitalizeFirst(error)}.`}
        </span>
      ) : null}
    </label>
  );
}
