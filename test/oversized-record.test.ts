import { expect, test } from "bun:test";
import { shape } from "../src/shape.ts";
import { more, shapeToolText, ResponseStore } from "../src/proxy.ts";

// A record bigger than the whole budget used to come back as "showing 0" with a "more" hint
// pointing at the same offset, so an agent paging for it looped forever.
const items = [
  { number: 1, body: "short" },
  { number: 2, body: "Windows ".repeat(4000) },
  { number: 3, body: "short too" },
];
const text = JSON.stringify({ total_count: 3, items });

test("a record larger than the budget is shown cut to fit, and declared", () => {
  const r = shape(text, { offset: 1, maxTokens: 300 });
  expect(r.stats?.shown).toBe(1);
  expect(r.text).toContain('"number":2');
  expect(r.text).toMatch(/record 2 is larger than the budget: text values cut to \d+ characters \(longest is 32000\)/);
});

test("contextquant_more moves past an oversized record", () => {
  const store = new ResponseStore(5);
  const first = shapeToolText(text, "search", { budget_tokens: 300 }, store)!;
  const handle = first.text.match(/handle="(r\d+)"/)![1];
  const page = (more({ handle, offset: 1, fields: ["number", "body"] }, { budget_tokens: 300 }, store).content[0] as { text: string }).text;
  expect(page).toContain('"number":2');
  expect(page).toContain("offset=2");
  expect(page).not.toContain("offset=1");
});
