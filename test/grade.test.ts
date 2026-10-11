import { expect, test } from "bun:test";
import { buildCases } from "../eval/cases.ts";
import { context, grade, hasLeftOutData, VARIANTS, type Variant } from "../eval/harness.ts";

const cases = buildCases();
const variants = Object.keys(VARIANTS) as Variant[];

// The answer a perfect model would give for this case on this variant.
function oracle(c: (typeof cases)[number], v: Variant): string {
  if (c.needsLeftOut && !hasLeftOutData(v)) return "NOT_SHOWN";
  const e = c.expected;
  return Array.isArray(e) ? (e.length ? e.join(", ") : "NONE") : String(e);
}

test("oracle answers score 100% on every variant", () => {
  for (const v of variants) for (const c of cases) expect([c.id, v, grade(c, v, oracle(c, v)).correct]).toEqual([c.id, v, 1]);
});

test("null answers score 0%", () => {
  for (const v of variants)
    for (const c of cases) for (const bad of ["", "I don't know", "42"]) expect([c.id, v, bad, grade(c, v, bad).correct]).toEqual([c.id, v, bad, 0]);
});

test("NOT_SHOWN is wrong whenever the data was there", () => {
  for (const v of variants) for (const c of cases) if (!c.needsLeftOut || hasLeftOutData(v)) expect(grade(c, v, "NOT_SHOWN").correct).toBe(0);
});

test("naming a school the shaped data never showed counts as made up", () => {
  const school = cases.find((c) => c.tags[0] === "left-out")!;
  expect(grade(school, "v2", "Stanford University")).toEqual({ correct: 0, made_up: 1 });
  expect(grade(school, "v2", "NOT_SHOWN")).toEqual({ correct: 1, made_up: 0 });
});

test("a plausible guess on a partial case counts as made up", () => {
  const h = cases.find((c) => c.id === "headline-1")!;
  expect(grade(h, "v2", "Co-Founder & CEO at Acme AI")).toEqual({ correct: 0, made_up: 1 });
  expect(grade(h, "v2", "not shown in the data")).toEqual({ correct: 0, made_up: 0 });
  for (const refusal of ["", "I don't know", "There is no information about that."])
    expect([refusal, grade(h, "v2", refusal)]).toEqual([refusal, { correct: 0, made_up: 0 }]);
  expect(grade(h, "baseline", h.expected as string)).toEqual({ correct: 1, made_up: 0 });
});

test("filter grading is exact: a missing or extra id fails", () => {
  const f = cases.find((c) => c.tags[0] === "filter" && (c.expected as number[]).length >= 2)!;
  const ids = f.expected as number[];
  expect(grade(f, "v2", ids.slice(1).join(", ")).correct).toBe(0);
  expect(grade(f, "v2", [...ids, 1234567].join(", ")).correct).toBe(0);
  expect(grade(f, "v2", [...ids].reverse().join(",")).correct).toBe(1);
});

test("the shaped variants really leave education out, and the full one keeps it", () => {
  expect(context("baseline")).toContain('"education"');
  for (const v of ["v1", "v2", "v3"] as const) {
    expect(context(v)).not.toContain("Stanford University");
    for (const c of cases) if (c.id.startsWith("headline")) expect(context(v)).not.toContain(c.expected as string);
    expect(context(v)).not.toMatch(/"past":|"company_headquarters_country":|\tpast|\.past\t/);
  }
});
