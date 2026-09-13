// Program status board tooling. Usage: bun scripts/loop/status.ts next|record <inc> <sha> <pr>|paid-total|set <epic> <status>
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
const ROOT = new URL("../../", import.meta.url).pathname;
const STATUS = `${ROOT}docs/loop/STATUS.md`;
type Row = { epic: string; title: string; deps: string[]; status: string; merged: number; last: string; evidence: string; raw: string };
const lines = readFileSync(STATUS, "utf8").split("\n");
const rows: Row[] = lines.filter(l => /^\| HV-0\d\d \|/.test(l)).map(l => {
  const c = l.split("|").map(s => s.trim());
  return { epic: c[1], title: c[2], deps: c[3] === "-" ? [] : c[3].split(",").map(s => s.trim()), status: c[4], merged: Number(c[5]) || 0, last: c[6], evidence: c[7], raw: l };
});
const started = (e: string) => Number(e.slice(3)) < 16 || ["done", "in_progress", "review"].includes(rows.find(r => r.epic === e)?.status ?? "");
const write = (r: Row) => { const i = lines.indexOf(r.raw); lines[i] = `| ${r.epic} | ${r.title} | ${r.deps.join(", ") || "-"} | ${r.status} | ${r.merged} | ${r.last} | ${r.evidence} |`; writeFileSync(STATUS, lines.join("\n")); };
const incDir = `${ROOT}docs/loop/increments/`;
const cmd = process.argv[2];
if (cmd === "next") {
  for (const r of rows) {
    if (!["todo", "in_progress"].includes(r.status) || !r.deps.every(started)) continue;
    const docs = existsSync(incDir) ? readdirSync(incDir).filter(f => f.startsWith(r.epic + "-") && f.endsWith(".md") && !f.endsWith(".blocked.md")) : [];
    const pending = docs.find(f => !readFileSync(incDir + f, "utf8").includes("merged_as:"));
    if (pending) { console.log(pending.replace(/\.md$/, "")); process.exit(0); }
    console.log(`${r.epic}-${String(docs.length + 1).padStart(2, "0")}`); process.exit(0);
  }
  process.exit(0);
} else if (cmd === "record") {
  const [inc, sha, pr] = process.argv.slice(3); const epic = inc.slice(0, 6);
  const p = `${incDir}${inc}.md`; writeFileSync(p, readFileSync(p, "utf8").trimEnd() + `\nmerged_as: ${sha} (PR #${pr})\n`);
  const r = rows.find(x => x.epic === epic)!; r.merged += 1; r.last = sha.slice(0, 7); if (r.status === "todo") r.status = "in_progress"; write(r);
  const pe = `${ROOT}docs/PROGRAM-EXECUTION.md`; const cur = readFileSync(pe, "utf8");
  writeFileSync(pe, cur.replace("## Current execution", `## Current execution\n\nLoop increment ${inc} merged as \`${sha}\` (PR #${pr}), ${new Date().toISOString().slice(0, 10)}. See docs/loop/increments/${inc}.md.\n`));
} else if (cmd === "set") {
  const [epic, status] = process.argv.slice(3); const r = rows.find(x => x.epic === epic)!; r.status = status; write(r);
} else if (cmd === "paid-total") {
  const f = `${ROOT}.loop/paid-ledger.jsonl`; let s = 0;
  if (existsSync(f)) for (const l of readFileSync(f, "utf8").split("\n").filter(Boolean)) s += Number(JSON.parse(l).usd) || 0;
  console.log(s.toFixed(2));
}
