// Eval cases: questions an agent would ask about one page of person-search results.
// Expected answers are computed from the fixture in code, never hand-written or model-made.
// `bun eval/cases.ts` writes eval/cases.md for review.
import { peopleSearch } from "../bench/people.ts";

export const FIXTURE = { n: 50, seed: 11 };

export interface Case {
  id: string;
  tags: string[]; // tags[0] = question type
  prompt: string;
  expected: string | number | number[] | string[];
  /** Answer needs a field the query-shaped arms leave out; they should reply NOT_SHOWN. */
  needsLeftOut?: boolean;
}

type Person = {
  crustdata_person_id: number;
  basic_profile: { name: string; current_title: string; headline: string; location: { city: string } };
  social_handles: { professional_network_identifier: { profile_url: string } };
  experience: { employment_details: { current: { name: string; company_headquarters_country: string }[]; past: { name: string }[] } };
  education: { schools: { school: string }[] };
};

export function buildCases(): Case[] {
  const data = peopleSearch(FIXTURE.n, FIXTURE.seed) as { profiles: Person[]; total_count: number };
  const ps = data.profiles;
  const nameCount = new Map<string, number>();
  for (const p of ps) nameCount.set(p.basic_profile.name, (nameCount.get(p.basic_profile.name) ?? 0) + 1);
  // Only people whose name is unique on the page, so "X's title" has one answer.
  const uniq = ps.filter((p) => nameCount.get(p.basic_profile.name) === 1);
  const at = (i: number) => uniq[i % uniq.length]!;
  const name = (p: Person) => p.basic_profile.name;
  const ids = (f: (p: Person) => boolean) => ps.filter(f).map((p) => p.crustdata_person_id).sort((a, b) => a - b);
  const cases: Case[] = [];

  [0, 3, 6, 9].forEach((i, k) => {
    const p = at(i);
    cases.push({ id: `title-${k + 1}`, tags: ["lookup"], prompt: `What is ${name(p)}'s current title?`, expected: p.basic_profile.current_title });
  });
  [1, 4, 7, 10].forEach((i, k) => {
    const p = at(i);
    cases.push({ id: `company-${k + 1}`, tags: ["lookup"], prompt: `Which company does ${name(p)} currently work at?`, expected: p.experience.employment_details.current[0]!.name });
  });
  [2, 5, 8].forEach((i, k) => {
    const p = at(i);
    cases.push({ id: `url-${k + 1}`, tags: ["copy"], prompt: `What is ${name(p)}'s LinkedIn profile URL? Reply with the full URL exactly.`, expected: p.social_handles.professional_network_identifier.profile_url });
  });
  ["San Francisco", "London", "Bengaluru", "Toronto", "Austin", "Paris"].forEach((city, k) => {
    cases.push({ id: `count-${k + 1}`, tags: ["count"], prompt: `How many people on this page are located in ${city}? Reply with a number.`, expected: ps.filter((p) => p.basic_profile.location.city === city).length });
  });
  const filters: [string, (p: Person) => boolean][] = [
    ["whose current title contains 'Co-Founder' and who are located in San Francisco", (p) => p.basic_profile.current_title.includes("Co-Founder") && p.basic_profile.location.city === "San Francisco"],
    ["whose current title contains 'Co-Founder'", (p) => p.basic_profile.current_title.includes("Co-Founder")],
    ["who currently work at Acme AI", (p) => p.experience.employment_details.current[0]!.name === "Acme AI"],
    ["whose current title starts with 'Head of' and who are located in the United States", (p) => p.basic_profile.current_title.startsWith("Head of") && ["San Francisco", "New York", "Austin"].includes(p.basic_profile.location.city)],
    ["who currently work at Orbital Pay and are located outside India", (p) => p.experience.employment_details.current[0]!.name === "Orbital Pay" && p.basic_profile.location.city !== "Bengaluru"],
    ["whose current title is exactly 'VP Engineering'", (p) => p.basic_profile.current_title === "VP Engineering"],
  ];
  filters.forEach(([desc, f], k) => {
    cases.push({ id: `filter-${k + 1}`, tags: ["filter"], prompt: `List the crustdata_person_id of every person on this page ${desc}. Reply with a comma-separated list of ids, or NONE if there are none.`, expected: ids(f) });
  });
  cases.push({ id: "total-1", tags: ["meta"], prompt: "How many people match this search in total, across all pages? Reply with a number.", expected: data.total_count });
  [11, 12, 13, 14, 15, 16].forEach((i, k) => {
    const p = at(i);
    cases.push({ id: `school-${k + 1}`, tags: ["left-out"], prompt: `Which school did ${name(p)} attend? If several, list them comma-separated.`, expected: [...new Set(p.education.schools.map((s) => s.school))], needsLeftOut: true });
  });
  // Misleading partial: the answer's field is left out, but related fields are shown, so a guess
  // looks plausible (headline is "<title> at <company> | …"; HQ country vs the person's city).
  [17, 18].forEach((i, k) => {
    const p = at(i);
    cases.push({ id: `headline-${k + 1}`, tags: ["partial"], prompt: `What is ${name(p)}'s profile headline? Reply with it exactly as written.`, expected: p.basic_profile.headline, needsLeftOut: true });
  });
  [19, 20].forEach((i, k) => {
    const p = at(i);
    cases.push({ id: `hq-${k + 1}`, tags: ["partial"], prompt: `In which country is ${name(p)}'s current company headquartered? Reply with the country exactly as written in the data.`, expected: p.experience.employment_details.current[0]!.company_headquarters_country, needsLeftOut: true });
  });
  [21, 22].forEach((i, k) => {
    const p = at(i);
    cases.push({ id: `past-${k + 1}`, tags: ["partial"], prompt: `List the companies ${name(p)} worked at before their current job, comma-separated.`, expected: [...new Set(p.experience.employment_details.past.map((r) => r.name))], needsLeftOut: true });
  });
  return cases;
}

if (import.meta.main) {
  const cases = buildCases();
  const cell = (s: string) => s.replace(/\|/g, "\\|");
  const show = (e: Case["expected"]) => cell(Array.isArray(e) ? (e.length ? e.join(", ") : "NONE") : String(e));
  const md = [
    "# Eval cases: person-search results",
    "",
    `Fixture: \`peopleSearch(${FIXTURE.n}, ${FIXTURE.seed})\` from bench/people.ts (synthetic, shaped like Crustdata's person search docs).`,
    "Expected answers are computed in code from the fixture. `left-out` cases: the full-JSON arm should answer the school;",
    "arms that keep only the query's fields should answer `NOT_SHOWN` (education isn't in their data).",
    "",
    "| id | type | question | expected |",
    "|---|---|---|---|",
    ...cases.map((c) => `| ${c.id} | ${c.tags[0]} | ${cell(c.prompt)} | ${show(c.expected)}${c.needsLeftOut ? " (full JSON) / NOT_SHOWN (shaped)" : ""} |`),
    "",
  ].join("\n");
  await Bun.write(new URL("./cases.md", import.meta.url), md);
  console.log(`wrote eval/cases.md (${cases.length} cases)`);
}
