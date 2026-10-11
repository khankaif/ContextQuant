/**
 * Derive response fields from a structured search request. The request already
 * identifies the attributes used to constrain a result, so this stays
 * deterministic and requires no model call.
 */
export function fieldsFromFilters(filters: unknown, base: string[] = [], rename: Record<string, string> = {}): string[] {
  const out = new Set(base);
  const walk = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const field = (v as { field?: unknown }).field;
    if (typeof field === "string") out.add(rename[field] ?? field);
    Object.values(v).forEach(walk);
  };
  walk(filters);
  return [...out];
}

/** Filter fields are useful aggregate candidates for count questions. */
export const filterFields = (filters: unknown, rename: Record<string, string> = {}) => fieldsFromFilters(filters, [], rename);
