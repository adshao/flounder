import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildArgs, specToConfig, ActivityBus } from "../dist/server/run-manager.js";
import { MetadataStore } from "../dist/db/store.js";
import { defaultOutputDir } from "../dist/config.js";

test("ActivityBus: a subscriber replays backlog then receives live events", () => {
  const bus = new ActivityBus();
  bus.push({ kind: "thinking_delta", delta: "The " });
  bus.push({ kind: "thinking_delta", delta: "decoder" });
  const seen = [];
  const unsub = bus.subscribe((ev) => seen.push(ev.delta ?? ev.tool ?? ev.kind));
  assert.deepEqual(seen, ["The ", "decoder"]); // backlog replayed on subscribe
  bus.push({ kind: "step", tool: "bash" });
  assert.deepEqual(seen, ["The ", "decoder", "bash"]); // live event delivered
  unsub();
  bus.push({ kind: "thinking_delta", delta: "x" });
  assert.equal(seen.length, 3); // no events after unsubscribe
});

test("ActivityBus: snapshot returns a bounded recent tail", () => {
  const bus = new ActivityBus();
  bus.push({ kind: "step", step: 1, tool: "read" });
  bus.push({ kind: "step", step: 2, tool: "bash" });
  bus.push({ kind: "thinking_delta", delta: "done" });
  assert.deepEqual(bus.snapshot(2).map((ev) => ev.tool ?? ev.delta), ["bash", "done"]);
  assert.deepEqual(bus.snapshot(10).map((ev) => ev.kind), ["step", "step", "thinking_delta"]);
});

// buildArgs is the pure core of launching: spec -> flounder CLI argv. The run-manager shells out
// to the same CLI, and continue/restart map to the kernel's resume / --remap behavior.

test("buildArgs: a full run spec maps to the expected verb + flags", () => {
  const args = buildArgs({
    verb: "run",
    target: "acme",
    sourcePaths: ["./contracts", "./src"],
    buildRoot: ".",
    corpusPaths: ["./docs"],
    provider: "openai-codex",
    model: "gpt-5.5",
    thinking: "xhigh",
    maxScopes: 12,
    mapSteps: 60,
    mapSamples: 2,
    digSteps: 60,
    digSamples: 2,
    digMaxSamples: 4,
    adaptiveDig: false,
    eagerPrepare: true,
    out: "runs",
  });
  assert.deepEqual(args, [
    "run",
    "--target", "acme",
    "--source", "./contracts", "./src",
    "--build-root", ".",
    "--corpus", "./docs",
    "--provider", "openai-codex",
    "--model", "gpt-5.5",
    "--thinking", "xhigh",
    "--max-scopes", "12",
    "--map-steps", "60",
    "--map-samples", "2",
    "--dig-steps", "60",
    "--dig-samples", "2",
    "--dig-max-samples", "4",
    "--no-adaptive-dig",
    "--eager-prepare",
    "--out", "runs",
  ]);
});

test("buildArgs: restart adds --remap; confirm takes the run dir positionally + --fresh", () => {
  assert.ok(buildArgs({ verb: "run", target: "p", sourcePaths: ["./s"], remap: true }).includes("--remap"));

  const confirm = buildArgs({ verb: "confirm", target: "p", sourcePaths: ["./s"], inputRunDir: "runs/p-123", fresh: true });
  assert.equal(confirm[0], "confirm");
  assert.equal(confirm[1], "runs/p-123"); // positional run dir
  assert.ok(confirm.includes("--fresh"));
  assert.ok(!confirm.includes("--remap")); // --remap is meaningless for confirm

  // audit can pin a region positionally
  const audit = buildArgs({ verb: "audit", target: "p", sourcePaths: ["./s"], region: "src/Foo.sol:10-40" });
  assert.equal(audit[1], "src/Foo.sol:10-40");
});

test("buildArgs: verify-from-start is an explicit run pipeline flag", () => {
  assert.ok(buildArgs({ verb: "run", target: "p", sourcePaths: ["./s"], verifyFromStart: true }).includes("--verify-from-start"));
  assert.equal(buildArgs({ verb: "audit", target: "p", sourcePaths: ["./s"], verifyFromStart: true }).includes("--verify-from-start"), false);
  assert.equal(specToConfig({ verb: "run", target: "p", sourcePaths: ["./s"], verifyFromStart: true }, "runs").auditVerifyFromStart, true);
});

test("verify concurrency is preserved across launch config and CLI args", () => {
  const spec = { verb: "run", target: "p", sourcePaths: ["./s"], verifyConcurrency: 3 };
  assert.equal(specToConfig(spec, "runs").auditVerifyConcurrency, 3);
  const args = buildArgs(spec);
  assert.deepEqual(args.slice(args.indexOf("--verify-concurrency"), args.indexOf("--verify-concurrency") + 2), ["--verify-concurrency", "3"]);
});

test("versioned coverage controls survive launch translation", () => {
  const spec = {
    verb: "run",
    target: "p",
    sourcePaths: ["./s"],
    mapSamples: 3,
    digSamples: 1,
    digMaxSamples: 4,
    adaptiveDig: true,
    eagerPrepare: true,
  };
  const cfg = specToConfig(spec, "runs");
  assert.equal(cfg.auditMapSamples, 3);
  assert.equal(cfg.auditDigSamples, 1);
  assert.equal(cfg.auditDigMaxSamples, 4);
  assert.equal(cfg.auditAdaptiveDig, true);
  assert.equal(cfg.auditEagerPrepare, true);
  const args = buildArgs(spec);
  assert.ok(args.includes("--map-samples"));
  assert.ok(args.includes("--dig-max-samples"));
  assert.ok(args.includes("--eager-prepare"));
  assert.equal(args.includes("--no-adaptive-dig"), false);
});

test("specToConfig: launch next actions are preserved for the audit prompt", () => {
  const cfg = specToConfig({
    verb: "run",
    target: "p",
    sourcePaths: ["./s"],
    nextActions: [
      {
        id: 7,
        kind: "resource-request",
        actionability: "agent-resource",
        recommendedAction: "resolve-resource",
        title: "Install Foundry dependencies",
        summary: "forge build needs package install",
        reason: "The agent should retry safe setup before asking for help.",
      },
    ],
  }, "runs");
  assert.equal(cfg.auditNextActions.length, 1);
  assert.equal(cfg.auditNextActions[0].recommendedAction, "resolve-resource");
  assert.equal(cfg.auditNextActions[0].actionability, "agent-resource");
});

test("buildArgs/specToConfig: append-map can carry extra seed inventories", () => {
  const args = buildArgs({ verb: "map", target: "p", sourcePaths: ["./s"], appendMap: true, appendMapSeedPaths: ["/old/audit_scopes.json", "local/scopes.json"] });
  assert.ok(args.includes("--append-map"));
  assert.deepEqual(args.slice(args.indexOf("--append-map-seed")), ["--append-map-seed", "/old/audit_scopes.json", "--append-map-seed", "local/scopes.json", "--out", defaultOutputDir()]);

  const cfg = specToConfig(
    { verb: "map", target: "p", dir: "proj", sourcePaths: ["src"], appendMap: true, appendMapSeedPaths: ["/old/audit_scopes.json", "local/scopes.json"] },
    "runs",
    os.tmpdir(),
  );
  assert.equal(cfg.auditAppendMap, true);
  assert.deepEqual(cfg.auditAppendMapSeedPaths, ["/old/audit_scopes.json", path.resolve(os.tmpdir(), "proj/local/scopes.json")]);
});

test("buildArgs: confirm without a run dir is rejected", () => {
  assert.throws(() => buildArgs({ verb: "confirm", target: "p", sourcePaths: ["./s"] }), /inputRunDir/);
});

test("buildArgs/specToConfig: sandbox isolation settings round-trip through launch specs", () => {
  const spec = {
    verb: "run",
    target: "p",
    sourcePaths: ["./s"],
    sandboxBackend: "apple-container",
    sandboxImage: "audit-sandbox:v1",
    sandboxAllowHostFallback: true,
    sandboxPrepareNetwork: "enabled",
    sandboxConfirmNetwork: "none",
    sandboxMemoryMb: 2048,
    sandboxCpus: 1.5,
  };
  assert.deepEqual(buildArgs(spec).slice(-15), [
    "--sandbox-backend", "apple-container",
    "--sandbox-image", "audit-sandbox:v1",
    "--allow-host-execution",
    "--prepare-network", "enabled",
    "--confirm-network", "none",
    "--sandbox-memory-mb", "2048",
    "--sandbox-cpus", "1.5",
    "--out", defaultOutputDir(),
  ]);

  const cfg = specToConfig(spec, "runs");
  assert.equal(cfg.sandboxBackend, "apple-container");
  assert.equal(cfg.sandboxImage, "audit-sandbox:v1");
  assert.equal(cfg.sandboxAllowHostFallback, true);
  assert.equal(cfg.sandboxPrepareNetwork, "enabled");
  assert.equal(cfg.sandboxConfirmNetwork, "none");
  assert.equal(cfg.sandboxMemoryMb, 2048);
  assert.equal(cfg.sandboxCpus, 1.5);
});

// The manager runs the library in-process; specToConfig is the spec -> AuditorConfig
// translation (the in-process equivalent of the CLI's parseConfig + applyAuditPosture).
test("specToConfig: posture per verb + unbounded budgets by default", () => {
  const base = { target: "p", sourcePaths: ["./s"] };

  const run = specToConfig({ ...base, verb: "run" }, "runs");
  assert.equal(run.auditDeep, true); // run = map -> dig
  assert.equal(run.outputDir, "runs");
  assert.equal(Number.isFinite(run.auditMaxSteps), false); // unbounded by default
  assert.equal(Number.isFinite(run.auditMapSteps), false);
  assert.equal(Number.isFinite(run.auditDigSteps), false);
  assert.equal(Number.isFinite(run.auditMaxScopes), false);

  assert.equal(specToConfig({ ...base, verb: "run", quick: true }, "runs").auditDeep, false); // --quick = breadth

  const map = specToConfig({ ...base, verb: "map" }, "runs");
  assert.equal(map.auditMapOnly, true);

  const region = specToConfig({ ...base, verb: "audit", region: "src/F.sol:10-40" }, "runs");
  assert.equal(region.auditDeepFocus, "src/F.sol:10-40");

  const scoped = specToConfig({ ...base, verb: "audit", scope: "s1, s2" }, "runs");
  assert.equal(scoped.auditRequireInventory, true);
  assert.deepEqual(scoped.auditScopeIds, ["s1", "s2"]);

  // explicit caps + materials + remap are carried
  const capped = specToConfig({ ...base, verb: "run", buildRoot: ".", model: "gpt-5.5", thinking: "xhigh", maxScopes: 8, mapSteps: 50, remap: true }, "out");
  assert.equal(capped.buildRoot, ".");
  assert.equal(capped.auditModel, "gpt-5.5");
  assert.equal(capped.thinkingLevel, "xhigh");
  assert.equal(capped.auditMaxScopes, 8);
  assert.equal(capped.auditMapSteps, 50);
  assert.equal(capped.auditRemap, true);

  const append = specToConfig({ ...base, verb: "map", appendMap: true }, "out");
  assert.equal(append.auditMapOnly, true);
  assert.equal(append.auditAppendMap, true);
});

test("specToConfig: a project dir + relative materials resolve under the daemon workspace", () => {
  const cfg = specToConfig(
    { verb: "run", target: "p", dir: "myproj", sourcePaths: ["src", "lib"], buildRoot: ".", corpusPaths: ["docs/specs"] },
    "runs",
    os.tmpdir(),
  );
  assert.equal(cfg.sourcePaths[0], path.resolve(os.tmpdir(), "myproj/src"));
  assert.equal(cfg.sourcePaths[1], path.resolve(os.tmpdir(), "myproj/lib"));
  assert.equal(cfg.buildRoot, path.resolve(os.tmpdir(), "myproj")); // "." resolves to the project root
  assert.equal(cfg.corpusPaths[0], path.resolve(os.tmpdir(), "myproj/docs/specs"));
});

test("specToConfig: project-relative specs cannot escape the daemon workspace", () => {
  assert.throws(
    () => specToConfig({ verb: "run", target: "p", dir: "p", sourcePaths: ["src"] }, "runs", path.join(os.tmpdir(), `flounder-missing-workspace-${process.pid}-${Date.now()}`)),
    /daemon workspace does not exist/,
  );
  assert.throws(
    () => specToConfig({ verb: "run", target: "p", dir: "../outside", sourcePaths: ["src"] }, "runs", os.tmpdir()),
    /Unsafe project dir/,
  );
  assert.throws(
    () => specToConfig({ verb: "run", target: "p", dir: "p", sourcePaths: ["../secret"] }, "runs", os.tmpdir()),
    /Unsafe project material/,
  );
  assert.throws(
    () => specToConfig({ verb: "run", target: "p", dir: "p", sourcePaths: ["/abs/secret"] }, "runs", os.tmpdir()),
    /absolute paths are not allowed/,
  );
});

test("specToConfig: real paths cannot escape through project or material symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flounder-spec-realpath-"));
  try {
    const workspace = path.join(root, "workspace");
    const outside = path.join(root, "outside");
    await mkdir(workspace);
    await mkdir(outside);
    await symlink(outside, path.join(workspace, "linked-project"), "dir");
    assert.throws(
      () => specToConfig({ verb: "run", target: "p", dir: "linked-project", sourcePaths: ["."] }, "runs", workspace),
      /symbolic link|outside the daemon workspace/,
    );

    const project = path.join(workspace, "project");
    await mkdir(project);
    await symlink(outside, path.join(project, "linked-source"), "dir");
    assert.throws(
      () => specToConfig({ verb: "run", target: "p", dir: "project", sourcePaths: ["linked-source"] }, "runs", workspace),
      /symbolic link|outside the daemon workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("specToConfig: per-phase models from the profile land on cfg.models; no dir = materials as-is", () => {
  const cfg = specToConfig(
    { verb: "run", target: "p", sourcePaths: ["/abs/x"], models: { map: { thinking: "low" }, dig: { model: "big" } } },
    "runs",
    "/ws",
  );
  assert.equal(cfg.sourcePaths[0], "/abs/x"); // no dir → used verbatim (ad-hoc/legacy)
  assert.equal(cfg.models.map.thinking, "low");
  assert.equal(cfg.models.dig.model, "big");
});

test("store: a supervisor reconciles a dead process's still-running row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "flounder-reconcile-"));
  const db = new MetadataStore(path.join(dir, "flounder.db"));
  const projectId = db.upsertProject({ name: "p" });
  db.startRun({ projectId, kind: "run", runDir: "/runs/p-1", pid: 4242 });

  assert.equal(db.reconcileRunByPid(4242, "killed"), 1); // the running row is marked killed
  assert.equal(db.listRuns(projectId)[0].status, "killed");
  assert.equal(db.reconcileRunByPid(4242, "error"), 0); // already ended → no-op
  db.close();
});
