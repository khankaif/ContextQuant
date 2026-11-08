import { expect, test } from "bun:test";
import { grade } from "../eval/github-agent.ts";

const t = (kind: "number" | "login" | "set" | "yesno", expect: string | number | number[]) =>
  ({ id: "x", payload: "x", q: "x", kind, prompt: "x", expect });

test("grades the last line, after any explanation", () => {
  expect(grade(t("number", 29), "I read all 30 issues. One has an assignee.\n\n29")).toBe(true);
  expect(grade(t("number", 29), "Every issue has no assignee.\n\n**30**")).toBe(false);
  expect(grade(t("number", 4647), "4,647")).toBe(true);
  expect(grade(t("login", "qwaz"), "Issue #165316 was opened by\n`qwaz`")).toBe(true);
  expect(grade(t("yesno", "no"), "The body talks about macOS? Let me check.\nNo")).toBe(true);
  expect(grade(t("yesno", "yes"), "I never saw the body.\n\nNot shown: the result isn't available to me, so I can't say yes or no.")).toBe(false);
  expect(grade(t("yesno", "yes"), "Yes. The body says it fails on Linux.")).toBe(true);
  expect(grade(t("set", [2510, 2685]), "Found them:\n#2685, #2510")).toBe(true);
  expect(grade(t("set", [2510, 2685]), "2510")).toBe(false);
  expect(grade(t("set", [165385, 165478]), "Two have it: 165478 and 165385. I checked all 30.\n\n165478\n165385")).toBe(true);  expect(grade(t("set", []), "NONE")).toBe(true);
});
