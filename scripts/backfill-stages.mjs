// Backfill run.stages_json (the dig-funnel data) for runs that finished BEFORE the funnel
// existed. Reconstructs each post-dig stage's outcome from the run dir's own evidence — the
// events.jsonl stream (synthesis / discharge-challenge) and the audit_differential.json /
// audit_refutation.json artifacts — so the funnel renders for historical runs too.
//
// Idempotent + read-only against the run dirs. Run with the daemon STOPPED (single writer):
//   node scripts/backfill-stages.mjs [outputDir=runs]
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { MetadataStore } from "../dist/db/store.js";

const OUT = process.argv[2] || "runs";

// Open + close via the store first, so the stages_json migration is applied before we write.
MetadataStore.openForOutput(OUT).close();

const dbPath = path.join(OUT, "flounder.db");
const db = new DatabaseSync(dbPath);

const readJSON = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const readEvents = (dir) => {
  const p = path.join(dir, "events.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

const runs = db.prepare("SELECT id, run_dir, kind, findings_total FROM run WHERE kind IN ('run','audit')").all();
let updated = 0;
for (const r of runs) {
  const dir = r.run_dir;
  if (!dir || !existsSync(dir)) continue;
  const events = readEvents(dir);
  const stages = {};

  // synthesis (G2): events carry scopes/findings (start) + produced (done).
  const synStart = events.find((e) => e.kind === "audit_synthesis_start");
  const synDone = events.find((e) => e.kind === "audit_synthesis_done");
  if (synStart || synDone) {
    const produced = synDone?.produced ?? 0;
    stages.synthesis = { scopes: synStart?.scopes, produced, pool: (synStart?.findings ?? 0) + produced };
  }

  // differential: the per-finding fix-equivalence results.
  const diff = readJSON(path.join(dir, "audit_differential.json"));
  if (Array.isArray(diff) && diff.length) stages.differential = { tested: diff.length, confirmed: diff.filter((x) => x.confirmed).length };

  // refutation: the skeptic's per-finding verdicts.
  const ref = readJSON(path.join(dir, "audit_refutation.json"));
  if (Array.isArray(ref) && ref.length) stages.refutation = { candidates: ref.length, refuted: ref.filter((x) => x.refuted).length, disputed: ref.filter((x) => x.refuted && !x.unrealistic).length };

  // discharge-challenge: start carries the discharged count; per-finding events carry unsound.
  const chStart = events.find((e) => e.kind === "audit_discharge_challenge_start");
  const chDone = events.find((e) => e.kind === "audit_discharge_challenge_done");
  const chPer = events.filter((e) => e.kind === "audit_discharge_challenge");
  if (chStart || chDone || chPer.length) {
    stages["discharge-challenge"] = {
      discharged: chStart?.discharged,
      challenged: chDone?.challenged ?? chPer.length,
      overturned: chDone?.overturned ?? chPer.filter((e) => e.unsound).length,
    };
  }

  if (Object.keys(stages).length === 0) continue;
  db.prepare("UPDATE run SET stages_json = ? WHERE id = ?").run(JSON.stringify(stages), r.id);
  updated++;
  console.log(`run #${r.id} (${r.kind}):`, JSON.stringify(stages));
}
console.log(`\nbackfilled ${updated} run(s)`);
db.close();
