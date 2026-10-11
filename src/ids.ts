import type { Json } from "./shape.ts";
import type { Tokenizer } from "./tokens.ts";

// Opaque = machine-made, meaningless to the model: Stripe-style `ch_3NxQ8k…`, UUIDs, hashes.
// URLs, emails and anything with a readable word in it (`maya-chen-8a1b2c3d`, `SKU-BLUE-…`) carry meaning, so they never count.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isOpaqueId(s: string): boolean {
  if (UUID.test(s)) return true;
  if (s.length < 12 || !/^[A-Za-z0-9_-]+$/.test(s)) return false;
  const prefixed = /^[A-Za-z]{1,10}_[A-Za-z0-9]{6,}$/.test(s);
  if (!prefixed && s.length < 16) return false;
  const body = prefixed ? s.slice(s.indexOf("_") + 1) : s;
  if (body.split(/[-_]/).some((w) => /^[A-Za-z]{3,}$/.test(w))) return false;
  // Random ids jump between upper, lower and digits; `name12345` jumps once.
  let shifts = 0;
  for (let i = 1; i < body.length; i++) if (kind(body[i]!) !== kind(body[i - 1]!)) shifts++;
  return shifts >= 4;
}
const kind = (c: string) => (c >= "0" && c <= "9" ? 0 : c >= "a" && c <= "z" ? 1 : c >= "A" && c <= "Z" ? 2 : 3);

/**
 * Short `@n` aliases for opaque IDs. One map per agent session, so the same ID
 * always gets the same alias and `@3` is never ambiguous when it comes back.
 * `@`, not `#`: a bare `#12` is common real data (issue numbers, channels).
 * ponytail: a real value that is exactly `@<n>` would still be rewritten; track seen literals if that shows up.
 */
export class AliasMap {
  #toAlias = new Map<string, string>();
  #toReal = new Map<string, string>();
  #rejected = new Set<string>();

  get size() {
    return this.#toAlias.size;
  }

  /** Alias for `real`, or undefined when the alias wouldn't save tokens. */
  tryAlias(real: string, tok: Tokenizer): string | undefined {
    const known = this.#toAlias.get(real);
    if (known || this.#rejected.has(real)) return known;
    const alias = `@${this.#toAlias.size + 1}`;
    if (tok.count(alias) >= tok.count(real)) {
      this.#rejected.add(real);
      return undefined;
    }
    this.#toAlias.set(real, alias);
    this.#toReal.set(alias, real);
    return alias;
  }

  real(alias: string): string | undefined {
    return this.#toReal.get(alias);
  }

  /**
   * Put real IDs back into tool-call arguments. Only strings that are exactly a
   * known alias are replaced; "@12" inside a longer string is left alone.
   */
  rewriteArgs(args: Json): Json {
    if (typeof args === "string") return (/^@\d+$/.test(args) && this.real(args)) || args;
    if (Array.isArray(args)) return args.map((a) => this.rewriteArgs(a));
    if (args && typeof args === "object") {
      return Object.fromEntries(Object.entries(args).map(([k, v]) => [k, this.rewriteArgs(v)]));
    }
    return args;
  }
}
