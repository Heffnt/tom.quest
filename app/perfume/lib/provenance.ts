// Provenance tooltip copy (DESIGN.md §1 "provenance", §9). A perfume instance —
// whether resting on the cauldron (OutputInstance) or held in an inventory
// (PerfumeInstance) — carries who brewed it, who witnessed it, and when. This is
// the SINGLE phrasing for that hover tooltip, shared by the inventory perfume
// slots and the cauldron output perfumes so the two never drift.

// The minimal flat-provenance shape both instance kinds project to.
export type ProvenanceView = {
  brewedByKey: string;
  witnesses: string[];
  brewedAt: number;
};

/** Resolve a memberKey to a display name; falls back to the key itself (already
 * a readable stored name in the local store, or a raw member key otherwise). */
export type NameResolver = (memberKey: string) => string;

/**
 * A resolver that prefers the live members list, then any per-instance stored
 * contributor/brewer name fields, then the raw key (DESIGN.md §1: "resolve via
 * the members list where possible, fall back to the stored name fields"). The
 * two sentinel keys used off-network read as friendly words.
 */
export function makeNameResolver(
  members: { memberKey: string; name: string }[],
): NameResolver {
  const byKey = new Map(members.map((m) => [m.memberKey, m.name]));
  return (memberKey: string): string => {
    const known = byKey.get(memberKey);
    if (known) return known;
    if (memberKey === "party") return "the party";
    if (memberKey === "local") return "you";
    return memberKey;
  };
}

function formatDate(at: number): string {
  if (!at) return "unknown date";
  try {
    return new Date(at).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "unknown date";
  }
}

/**
 * The provenance hover string:
 *   "brewed by {name} · witnessed by {names|nobody} · {date}"
 */
export function provenanceTooltip(p: ProvenanceView, resolveName: NameResolver): string {
  const brewer = resolveName(p.brewedByKey);
  const witnessed =
    p.witnesses.length > 0
      ? p.witnesses.map(resolveName).join(", ")
      : "nobody";
  return `brewed by ${brewer} · witnessed by ${witnessed} · ${formatDate(p.brewedAt)}`;
}
