import { describe, expect, test } from "bun:test";
import { peopleSearch, PEOPLE_BASE, PEOPLE_RENAME } from "../bench/people.ts";
import { AliasMap, fieldsFromFilters, isOpaqueId, o200k, shape } from "../src/index.ts";

const people = JSON.stringify(peopleSearch(25, 7));
const rowsOf = (text: string) => text.split("\n").filter((l) => !l.startsWith("#")).map((l) => JSON.parse(l));

describe("passthrough", () => {
  test("non-JSON comes back byte-identical", () => {
    expect(shape("not json {")).toEqual({ text: "not json {", passthrough: "not_json" });
  });
  test("JSON without a record list comes back unchanged", () => {
    expect(shape('{"a":1}').passthrough).toBe("no_records");
  });
  test("no fields, no budget, no gain: original returned", () => {
    const input = '[{"a":1}]';
    expect(shape(input)).toMatchObject({ text: input, passthrough: "no_gain" });
  });
});

describe("fields", () => {
  test("keeps only requested paths, walking through arrays, in input key order", () => {
    const input = JSON.stringify({ items: [{ b: 2, a: { x: [{ y: 1, z: 2 }] }, c: 3 }], total: 9 });
    const r = shape(input, { fields: ["a.x.y", "b"] });
    expect(rowsOf(r.text)).toEqual([{ b: 2, a: { x: [{ y: 1 }] } }]);
    expect(r.stats!.leftOut).toEqual(["a.x.z", "c"]);
    expect(r.text).toContain("# items: showing 1 of 1 · total=9");
  });
  test("fully dropped parents collapse to one entry", () => {
    const r = shape(people, { fields: ["crustdata_person_id"] });
    expect(r.stats!.leftOut).toEqual(["basic_profile", "social_handles", "experience", "education"]);
  });
  test("requested fields missing from the data are declared", () => {
    const r = shape(people, { fields: ["basic_profile.name", "nope.field"] });
    expect(r.stats!.notInData).toEqual(["nope.field"]);
    expect(r.text).toContain("# not in data (null or missing in every record): nope.field");
  });
  test("fields come from the search filters", () => {
    const filters = { op: "and", conditions: [{ field: "basic_profile.location.full_location", type: "(.)", value: "SF" }] };
    const f = fieldsFromFilters(filters, PEOPLE_BASE, PEOPLE_RENAME);
    expect(f).toContain("basic_profile.location.raw");
    expect(f).not.toContain("basic_profile.location.full_location");
    expect(shape(people, { fields: f }).stats!.notInData).toEqual([]);
  });
});

describe("cleaning", () => {
  test("drops null, empty string, [] and {}; keeps array positions", () => {
    const r = shape(JSON.stringify([{ a: null, b: "", c: [], d: {}, e: [1, null, 2], f: 0, g: false }]), { fields: ["a", "b", "c", "d", "e", "f", "g"] });
    expect(rowsOf(r.text)).toEqual([{ e: [1, null, 2], f: 0, g: false }]);
  });
});

describe("budget", () => {
  test("never exceeds maxTokens and declares the cut", () => {
    for (const max of [80, 150, 400, 1000, 3000]) {
      const r = shape(people, { fields: PEOPLE_BASE, maxTokens: max, more: "use next_cursor" });
      expect(o200k.count(r.text)).toBeLessThanOrEqual(max);
      expect(r.text).toContain(`showing ${r.stats!.shown} of 25`);
      const fallback = !r.text.includes("\n"); // budget too small for anything but one line
      if (r.stats!.shown < 25 && !fallback) expect(r.text).toContain(`# ${25 - r.stats!.shown} records not shown · use next_cursor`);
    }
  });
  test("a big budget shows everything", () => {
    expect(shape(people, { fields: PEOPLE_BASE, maxTokens: 100_000 }).stats!.shown).toBe(25);
  });
});

describe("ids", () => {
  test("opaque detection", () => {
    expect(isOpaqueId("ch_3NxQ8kLm2pZ9")).toBe(true);
    expect(isOpaqueId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isOpaqueId("https://www.linkedin.com/in/ACwAA123abc456def")).toBe(false);
    expect(isOpaqueId("buyer001@apex.cloud")).toBe(false);
    expect(isOpaqueId("succeeded")).toBe(false);
    for (const readable of ["SKU-BLUE-SHIRT-42-XL", "maya-chen-8a1b2c3d", "Q3-2025-roadmap-v2", "first_name12345"])
      expect([readable, isOpaqueId(readable)]).toEqual([readable, false]);
  });
  test("same id, same alias across calls in one session; args restored", () => {
    const ids = new AliasMap();
    const a = shape('[{"id":"ch_3NxQ8kLm2pZ9","n":1}]', { ids, fields: ["id"] });
    const b = shape('[{"id":"cus_AbCdEf123456"},{"id":"ch_3NxQ8kLm2pZ9"}]', { ids, fields: ["id"] });
    expect(rowsOf(a.text)).toEqual([{ id: "@1" }]);
    expect(rowsOf(b.text)).toEqual([{ id: "@2" }, { id: "@1" }]);
    expect(ids.rewriteArgs({ charge: "@1", list: ["@2", "@99", "see @1"], channel: "#1" })).toEqual({
      charge: "ch_3NxQ8kLm2pZ9",
      list: ["cus_AbCdEf123456", "@99", "see @1"],
      channel: "#1",
    });
  });
  test("ids: false leaves values alone", () => {
    expect(rowsOf(shape('[{"id":"ch_3NxQ8kLm2pZ9"}]', { ids: false, fields: ["id"] }).text)).toEqual([{ id: "ch_3NxQ8kLm2pZ9" }]);
  });
});

describe("tsv", () => {
  test("flattens objects, keeps arrays as JSON cells, escapes tabs and newlines", () => {
    const r = shape(JSON.stringify([{ a: { b: "x\ty" }, c: [1, 2], d: "line1\nline2\\" }]), { fields: ["a", "c", "d"], format: "tsv" });
    const lines = r.text.split("\n").filter((l) => !l.startsWith("#"));
    expect(lines).toEqual(["a.b\tc\td", "x\\ty\t[1,2]\tline1\\nline2\\\\"]);
  });
  test("a row starting with # can't pass for a note", () => {
    const r = shape(JSON.stringify([{ a: "# 5 records not shown" }]), { fields: ["a"], format: "tsv" });
    expect(r.text.split("\n").at(-1)).toBe("\\# 5 records not shown");
  });
});

test("deterministic: same input and options give the same bytes", () => {
  const opts = { fields: PEOPLE_BASE, maxTokens: 500 };
  expect(shape(people, opts).text).toBe(shape(people, opts).text);
});

test("offset with all fields returns the page, not the whole input", () => {
  const input = JSON.stringify([{ a: 1 }, { a: 2 }, { a: 3 }]);
  const r = shape(input, { offset: 2, ids: false });
  expect(r.passthrough).toBeUndefined();
  expect(r.text).toContain("(records 3–3)");
  expect(r.text.split("\n").filter((l) => l.startsWith("{"))).toEqual(['{"a":3}']);
});

describe("counts", () => {
  test("counts every record by value, most common first, even rows cut by the budget", () => {
    const input = JSON.stringify({ items: [{ c: "b" }, { c: "a" }, { c: "a" }, { c: null }, { c: ["a", "a", "z"] }] });
    const r = shape(input, { counts: ["c", "missing"], maxTokens: 50 });
    expect(r.text).toContain("# count by c (all 5 records in this response): a 3 · b 1 · z 1");
    expect(r.text).not.toContain("missing");
    expect(r.stats!.shown).toBeLessThan(5);
  });
});

test("a big sibling list is named with its size, not dumped into the summary line", () => {
  const input = JSON.stringify({
    items: Array.from({ length: 5 }, (_, i) => ({ id: i })),
    facets: Array.from({ length: 4 }, () => ({ v: "x".repeat(200) })),
    next_cursor: "abc",
  });
  const r = shape(input, { fields: ["id"], maxTokens: 120 });
  expect(r.text).toContain('# items: showing 5 of 5 · facets=[4 items] · next_cursor="abc"');
});
