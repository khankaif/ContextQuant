// Print what an agent reads for one captured search, raw or through ContextQuant, then its token count.
//   bun bench/compare/demo.ts raw [payload]      default payload: vscode-bugs
//   bun bench/compare/demo.ts cq  [payload]
// On a terminal, lines are clipped to the screen width so wide rows don't wrap; the token count is
// always for the full, unclipped text the agent would get. Used for media/demo.tape.
import { readFileSync } from "node:fs";
import { ResponseStore, shapeToolText } from "../../src/proxy.ts";
import { o200k } from "../../src/tokens.ts";

const [arm = "raw", name = "vscode-bugs"] = process.argv.slice(2);
const raw = readFileSync(new URL(`./payloads/${name}.txt`, import.meta.url), "utf8");
const out = arm === "cq" ? shapeToolText(raw, "search_issues", {}, new ResponseStore(1))!.text : raw;
const cols = process.stdout.isTTY ? process.stdout.columns - 1 : Infinity;
const clipped = out.split("\n").map((l) => (l.length > cols ? `${l.slice(0, cols - 1)}…` : l));
const note = clipped.some((l, i) => l !== out.split("\n")[i]) ? "  (lines clipped to fit the screen; the agent gets them whole)" : "";
console.log(`${clipped.join("\n")}\n\n${o200k.count(out).toLocaleString("en-US")} tokens${note}`);
