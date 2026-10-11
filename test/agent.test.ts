import { expect, test } from "bun:test";
import { buildTasks, grade, search, toolResult, people, DB } from "../eval/agent.ts";

const tasks = buildTasks();
const company = (co: string) => ({ op: "and", conditions: [{ field: "experience.employment_details.current.name", type: "=", value: co }] });

test("paging with next_cursor returns every match exactly once", () => {
  const filters = company("Acme AI");
  const seen: number[] = [];
  let cursor: string | undefined;
  do {
    const r = search({ filters, cursor }) as { profiles: { crustdata_person_id: number }[]; next_cursor: string | null; total_count: number };
    seen.push(...r.profiles.map((p) => p.crustdata_person_id));
    expect(r.profiles.length).toBeLessThanOrEqual(DB.page);
    cursor = r.next_cursor ?? undefined;
  } while (cursor);
  const want = people.filter((p) => p.experience.employment_details.current[0]!.name === "Acme AI").map((p) => p.crustdata_person_id);
  expect(seen.sort()).toEqual(want.sort());
  expect(new Set(seen).size).toBe(seen.length);
});

test("filters: contains, location rename, or, bad input becomes an error result", () => {
  const sf = search({ filters: { op: "and", conditions: [{ field: "basic_profile.location.full_location", type: "(.)", value: "san francisco" }] } }) as { total_count: number };
  expect(sf.total_count).toBe(people.filter((p) => p.basic_profile.location.city === "San Francisco").length);
  const either = search({ filters: { op: "or", conditions: [company("Acme AI"), company("Orbital Pay")] } }) as { total_count: number };
  expect(either.total_count).toBe(people.filter((p) => ["Acme AI", "Orbital Pay"].includes(p.experience.employment_details.current[0]!.name)).length);
  expect(JSON.parse(toolResult("cq", { filters: { op: "xor", conditions: [] } }))).toEqual({ error: "unknown op: xor" });
  expect(JSON.parse(toolResult("raw", {} as never))).toEqual({ error: "filters is required" });
  expect(JSON.parse(toolResult("raw", { filters: company("Acme AI"), cursor: "0" })).error).toStartWith("invalid cursor");
  expect(toolResult("raw", { filters: company("Acme AI"), cursor: "" })).toBe(toolResult("raw", { filters: company("Acme AI") }));
});

test("every list task needs a second page, and the oracle answer grades correct", () => {
  for (const t of tasks) {
    const e = t.expected;
    expect([t.id, grade(t, Array.isArray(e) ? e.join(", ") : String(e))]).toEqual([t.id, true]);
    expect([t.id, grade(t, "NOT_FOUND")]).toEqual([t.id, false]);
    if (t.kind === "ids") expect((e as number[]).length).toBeGreaterThan(DB.page);
  }
});

test("set grading: a wrong extra value or a missing one fails", () => {
  const s = tasks.find((t) => t.id === "schools-1")!;
  const [a, b] = s.expected as string[];
  expect(grade(s, `${a}, ${b}`)).toBe(true);
  expect(grade(s, `${a}`)).toBe(false);
  expect(grade(s, `${a}, ${b}, ${s.universe!.find((u) => u !== a && u !== b)}`)).toBe(false);
});

test("cq declares the left-out headline; asking for it brings it back in cq and fields", () => {
  const h = tasks.find((t) => t.id === "headline-1")!;
  const filters = { op: "and", conditions: [{ field: "basic_profile.name", type: "=", value: h.prompt.match(/of (.+?) \(/)![1] }] };
  expect(toolResult("cq", { filters })).toMatch(/# left out fields: .*basic_profile\.headline/);
  expect(toolResult("fields", { filters })).not.toContain(h.expected as string);
  for (const v of ["cq", "fields", "raw"] as const) expect(toolResult(v, { filters, fields: ["basic_profile.headline"] })).toContain(h.expected as string);
});
