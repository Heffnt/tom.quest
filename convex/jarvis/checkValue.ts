// checkValue.ts — a Convex validator, checked against a value inside a
// mutation. A mutation's args are checked by Convex only when it is called
// through ctx.runMutation; a record hook runs the same body inside the record
// mutation, so it checks the body's own validator here instead of copying it
// into hand-written ifs that could drift from it.

import type { GenericValidator } from "convex/values";

type Shape = {
  kind: string;
  isOptional?: "optional" | "required";
  value?: unknown;
  fields?: Record<string, Shape>;
  members?: Shape[];
  element?: Shape;
};

/** The first thing wrong with `value` under `validator`, as a sentence
 *  naming where, or null when it passes. */
export function checkValue(validator: GenericValidator, value: unknown, at = "value"): string | null {
  const shape = validator as unknown as Shape;
  switch (shape.kind) {
    case "any":
      return null;
    case "string":
    case "id":
      return typeof value === "string" ? null : `${at} must be a string`;
    case "float64":
      return typeof value === "number" ? null : `${at} must be a number`;
    case "boolean":
      return typeof value === "boolean" ? null : `${at} must be a boolean`;
    case "null":
      return value === null ? null : `${at} must be null`;
    case "literal":
      return value === shape.value ? null : `${at} must be ${JSON.stringify(shape.value)}`;
    case "array": {
      if (!Array.isArray(value)) return `${at} must be an array`;
      for (let i = 0; i < value.length; i++) {
        const fault = checkValue(shape.element as unknown as GenericValidator, value[i], `${at}[${i}]`);
        if (fault !== null) return fault;
      }
      return null;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return `${at} must be an object`;
      const record = value as Record<string, unknown>;
      const fields = shape.fields ?? {};
      for (const key of Object.keys(record)) {
        if (!(key in fields) && record[key] !== undefined) return `${at}.${key} is not a field it takes`;
      }
      for (const [key, field] of Object.entries(fields)) {
        if (record[key] === undefined) {
          if (field.isOptional === "optional") continue;
          return `${at}.${key} is required`;
        }
        const fault = checkValue(field as unknown as GenericValidator, record[key], `${at}.${key}`);
        if (fault !== null) return fault;
      }
      return null;
    }
    case "union": {
      const members = shape.members ?? [];
      const faults = members.map((member) => checkValue(member as unknown as GenericValidator, value, at));
      if (faults.some((fault) => fault === null)) return null;
      // A union of objects told apart by a literal `kind` answers with the
      // member that kind names, which is the one the writer meant.
      const kind = (value as { kind?: unknown } | null)?.kind;
      const named = members.findIndex((member) => member.fields?.kind?.value === kind);
      return named >= 0 ? faults[named] : `${at} matches none of its ${members.length} shapes`;
    }
    default:
      return `${at}: a ${shape.kind} validator is not checked here`;
  }
}
