// What each eval variant shows the model, the instructions, and the grader.
import { peopleSearch, SAMPLE_QUERY } from "../bench/people.ts";
import { fieldsFromFilters, filterFields } from "../src/intent.ts";
import { PEOPLE_BASE, PEOPLE_RENAME } from "../src/adapters/crustdata.ts";
import { projectRecords, shape } from "../src/shape.ts";
import { FIXTURE, type Case } from "./cases.ts";

/** Variant names are fixed by the report builder: baseline, v1, v2… */
export const VARIANTS = {
  baseline: "full JSON (minified API response, no field selection)",
  v1: "query fields as minified JSON (what the API's own `fields` parameter returns)",
  v2: "ContextQuant json: query fields + notes on what was left out + counts by filter field",
  v3: "ContextQuant tsv: same as v2 but as a table",
} as const;
export type Variant = keyof typeof VARIANTS;

export const SYSTEM =
  "You answer questions about the result of a person_search tool call. Use only that tool result. " +
  "Reply with only the answer: one value, or a comma-separated list when asked for a list. " +
  "If the tool result does not contain the information needed to answer, reply exactly NOT_SHOWN.";

export function context(variant: Variant): string {
  const min = JSON.stringify(peopleSearch(FIXTURE.n, FIXTURE.seed));
  const fields = fieldsFromFilters(SAMPLE_QUERY.filters, PEOPLE_BASE, PEOPLE_RENAME);
  const counts = filterFields(SAMPLE_QUERY.filters, PEOPLE_RENAME);
  switch (variant) {
    case "baseline":
      return min;
    case "v1":
      return JSON.stringify(projectRecords(min, fields));
    case "v2":
      return shape(min, { fields, counts }).text;
    case "v3":
      return shape(min, { fields, counts, format: "tsv" }).text;
  }
}

export const userMessage = (ctx: string, question: string) =>
  `<tool_result name="person_search">\n${ctx}\n</tool_result>\n\nQuestion: ${question}`;

/** Only the full-JSON variant carries the left-out fields; the others should answer NOT_SHOWN. */
export const hasLeftOutData = (variant: Variant) => variant === "baseline";

const norm = (s: string) =>
  s.trim().replace(/^["'`*]+|["'`*.]+$/g, "").replace(/\s+/g, " ").toLowerCase();
const ABSTAIN = /\b(unknown|not (shown|available|provided|included|listed|given|present|mentioned|specified)|(don't|do not|cannot|can't) (know|tell|determine|say|find)|no (information|data))\b/i;
const KNOWN_SCHOOLS = ["stanford", "iit bombay", "cambridge", "mit", "waterloo", "tu munich", "berkeley"];

export interface Grade {
  correct: number;
  /** 1 when the model asserted an answer the data it saw could not support. */
  made_up: number;
}

export function grade(c: Case, variant: Variant, answer: string): Grade {
  const a = norm(answer);
  const said = (s: string) => a.includes(s.toLowerCase());
  const notShown = /not_shown/i.test(answer);
  const ints = (answer.replace(/(\d),(\d{3})\b/g, "$1$2").match(/\d+/g) ?? []).map(Number);
  let correct = false;
  let madeUp = false;

  switch (c.tags[0]) {
    case "lookup":
      correct = !notShown && said(String(c.expected)) && a.length <= String(c.expected).length * 2 + 10;
      break;
    case "copy": {
      const urls = answer.match(/https?:\/\/\S+/g)?.map((u) => u.replace(/[).,>`*]+$/, "")) ?? [];
      correct = urls.length === 1 && urls[0] === c.expected;
      break;
    }
    case "count":
    case "meta":
      correct = ints.length > 0 && ints[0] === c.expected;
      break;
    case "filter": {
      const want = c.expected as number[];
      const got = [...new Set(ints.filter((n) => n >= 1_000_000))].sort((x, y) => x - y);
      correct = want.length === 0 ? got.length === 0 && /none/i.test(answer) : JSON.stringify(got) === JSON.stringify(want);
      break;
    }
    case "left-out":
    case "partial": {
      // left-out: nothing related is shown. partial: related fields are shown (title, company,
      // location), so a guess looks plausible; any answer other than NOT_SHOWN is made up.
      const want = [c.expected].flat().map(String);
      const guessed = c.tags[0] === "left-out" ? KNOWN_SCHOOLS.some((s) => new RegExp(`\\b${s}\\b`).test(a)) : a !== "" && !notShown && !ABSTAIN.test(answer);
      if (hasLeftOutData(variant)) correct = !notShown && want.every((s) => said(s));
      else {
        correct = notShown && !guessed;
        madeUp = guessed;
      }
      break;
    }
    default:
      throw new Error(`no grader for case type ${c.tags[0]}`);
  }
  return { correct: correct ? 1 : 0, made_up: madeUp ? 1 : 0 };
}
