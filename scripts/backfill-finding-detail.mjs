// One-off: populate the finding rich-content columns (description / evidence / exploit_sketch /
// fix / confidence) for findings recorded BEFORE those columns existed. Reads each project's run-dir
// artifacts (audit_hypotheses.json + audit_findings.json), matches findings by title (newest run
// wins), and fills only empty columns (COALESCE-keep, so it never clobbers content already present).
// Safe to re-run. Best run while the daemon/API are stopped; WAL + busy_timeout tolerate a live DB.
//
// Usage: node scripts/backfill-finding-detail.mjs [path/to/flounder.db]
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const DB = process.argv[2] || "runs/flounder.db";
if (!fs.existsSync(DB)) { console.error(`no DB at ${DB}`); process.exit(1); }
const db = new DatabaseSync(DB);
db.exec("PRAGMA busy_timeout = 8000");
for (const col of ["description TEXT", "evidence TEXT", "exploit_sketch TEXT", "fix TEXT", "confidence REAL"]) {
  try { db.exec(`ALTER TABLE finding ADD COLUMN ${col}`); } catch { /* already present */ }
}

const readArr = (f) => { try { const j = JSON.parse(fs.readFileSync(f, "utf8")); return Array.isArray(j) ? j : j.findings || j.hypotheses || []; } catch { return []; } };

// project_id -> (title -> rich content), built newest-run-first so the latest writeup wins.
const byProject = new Map();
const runs = db.prepare("SELECT project_id, run_dir FROM run WHERE run_dir IS NOT NULL ORDER BY id DESC").all();
for (const r of runs) {
  const m = byProject.get(r.project_id) ?? new Map();
  byProject.set(r.project_id, m);
  for (const art of ["audit_hypotheses.json", "audit_findings.json"]) {
    for (const e of readArr(path.join(String(r.run_dir), art))) {
      const t = (e?.title ?? "").trim();
      if (!t || m.has(t)) continue;
      m.set(t, { description: e.description ?? null, evidence: e.evidence ?? null, exploitSketch: e.exploitSketch ?? null, fix: e.fix ?? null, confidence: typeof e.confidence === "number" ? e.confidence : null });
    }
  }
}

const upd = db.prepare(
  `UPDATE finding SET description = COALESCE(NULLIF(?, ''), description), evidence = COALESCE(NULLIF(?, ''), evidence),
     exploit_sketch = COALESCE(NULLIF(?, ''), exploit_sketch), fix = COALESCE(NULLIF(?, ''), fix), confidence = COALESCE(?, confidence)
   WHERE id = ?`,
);
let filled = 0, unmatched = 0, already = 0;
for (const f of db.prepare("SELECT id, project_id, title, description FROM finding").all()) {
  if (f.description) { already++; continue; }
  const c = byProject.get(f.project_id)?.get((f.title ?? "").trim());
  if (!c) { unmatched++; continue; }
  upd.run(c.description, c.evidence, c.exploitSketch, c.fix, c.confidence, f.id);
  filled++;
}
console.log(`backfill: filled ${filled}, already-had-detail ${already}, unmatched ${unmatched} (of ${filled + already + unmatched} findings)`);
db.close();
