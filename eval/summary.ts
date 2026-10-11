// Per-model, per-variant accuracy from the eval results on disk.
//   bun eval/summary.ts            all flows under .claude/hillclimb/
//   bun eval/summary.ts people-gemma4
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { VARIANTS } from "./harness.ts";

const root = ".claude/hillclimb";
const flows = Bun.argv.slice(2).length ? Bun.argv.slice(2) : readdirSync(root).filter((f) => existsSync(`${root}/${f}/_state.json`));

type Row = { status: string; tags: string[]; grade: { correct: number; made_up: number }; context_tokens: number };

for (const flow of flows) {
  console.log(`\n## ${flow}`);
  console.log("| variant | correct | ±95% | made up | not scored | ctx tokens | lookup | copy | count | filter | meta | left-out | partial |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const v of Object.keys(VARIANTS)) {
    const file = `${root}/${flow}/${v}/results.jsonl`;
    if (!existsSync(file)) continue;
    const rows: Row[] = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const ok = rows.filter((r) => r.status === "ok");
    const errFile = `${root}/${flow}/${v}/errors.jsonl`;
    const errors = existsSync(errFile) ? readFileSync(errFile, "utf8").split("\n").filter(Boolean).length : 0;
    const n = ok.length;
    const p = n ? ok.reduce((s, r) => s + r.grade.correct, 0) / n : 0;
    const ci = n ? 1.96 * Math.sqrt((p * (1 - p)) / n) : 0; // ponytail: normal approximation; fine at n≥30, rough near 0%/100%
    const byType = (t: string) => {
      const xs = ok.filter((r) => r.tags[0] === t);
      return xs.length ? `${Math.round((100 * xs.reduce((s, r) => s + r.grade.correct, 0)) / xs.length)}%` : "-";
    };
    console.log(
      `| ${v} | ${n ? `${(100 * p).toFixed(0)}% (${n})` : "-"} | ${n ? `±${(100 * ci).toFixed(0)}` : "-"} | ${ok.reduce((s, r) => s + r.grade.made_up, 0)} | ` +
        `${rows.length - n} truncated, ${errors} failed attempts | ${rows[0]?.context_tokens ?? "-"} | ` +
        ["lookup", "copy", "count", "filter", "meta", "left-out", "partial"].map(byType).join(" | ") + " |",
    );
  }
}
console.log("\nVariants:", Object.entries(VARIANTS).map(([k, d]) => `${k} = ${d}`).join("; "));
