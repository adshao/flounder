import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  inspectManifest,
  inspectAllowlist,
  inspectNpmConfiguration,
  inspectTrackedEntries,
  inspectWorkflow,
  inspectWorkflowIntegrity,
} from "../scripts/check-supply-chain.mjs";

const safeLockfile = {
  lockfileVersion: 3,
  packages: {
    "": {},
    "node_modules/example": {
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
      integrity: "sha512-example",
    },
  },
};

test("registry dependencies with integrity metadata pass", () => {
  assert.deepEqual(
    inspectManifest({ dependencies: { example: "1.0.0" } }, safeLockfile),
    [],
  );
});

test("implicit install and packaging lifecycle scripts are rejected", () => {
  const findings = inspectManifest(
    {
      scripts: {
        postinstall: "node scripts/bootstrap.mjs",
        prepack: "node scripts/build.mjs",
        publish: "node scripts/publish.mjs",
        postpublish: "node scripts/postpublish.mjs",
        preversion: "node scripts/version.mjs",
        preprepare: "node scripts/prepare.mjs",
        dependencies: "node scripts/changed.mjs",
      },
    },
    safeLockfile,
  );

  assert.deepEqual(findings.map((item) => item.id), [
    "root-install-script",
    "root-install-script",
    "root-install-script",
    "root-install-script",
    "root-install-script",
    "root-install-script",
    "root-install-script",
  ]);
});

test("Git and URL dependencies are rejected", () => {
  const findings = inspectManifest(
    { dependencies: { example: "git+https://example.invalid/repo.git" } },
    safeLockfile,
  );

  assert.deepEqual(findings.map((item) => item.id), ["non-registry-dependency"]);
});

test("production versions must be exact and dependency versions cannot be unbounded", () => {
  const findings = inspectManifest(
    {
      dependencies: { ranged: "^1.0.0" },
      peerDependencies: { anything: "*" },
    },
    safeLockfile,
  );

  assert.deepEqual(findings.map((item) => item.id), [
    "unpinned-production-dependency",
    "unbounded-dependency-version",
  ]);
});

test("every resolved registry artifact requires integrity, including dev dependencies", () => {
  const lockfile = structuredClone(safeLockfile);
  delete lockfile.packages["node_modules/example"].integrity;
  lockfile.packages["node_modules/example"].dev = true;

  assert.deepEqual(inspectManifest({}, lockfile).map((item) => item.id), [
    "missing-package-integrity",
  ]);
});

test("every dependency must resolve to an exact registry artifact", () => {
  const lockfile = structuredClone(safeLockfile);
  delete lockfile.packages["node_modules/example"].resolved;

  assert.deepEqual(inspectManifest({}, lockfile).map((item) => item.id), [
    "missing-package-resolution",
  ]);
});

test("production dependency install scripts are rejected", () => {
  const lockfile = structuredClone(safeLockfile);
  lockfile.packages["node_modules/example"].hasInstallScript = true;

  assert.deepEqual(inspectManifest({}, lockfile).map((item) => item.id), [
    "unreviewed-dependency-install-script",
  ]);
});

test("install scripts require an exact version and integrity allowlist entry", () => {
  const lockfile = structuredClone(safeLockfile);
  lockfile.packages["node_modules/example"].hasInstallScript = true;
  const allowlist = {
    installScripts: [
      {
        path: "node_modules/example",
        version: "1.0.0",
        integrity: "sha512-example",
        reason: "Reviewed package fixture.",
      },
    ],
  };

  assert.deepEqual(inspectManifest({}, lockfile, allowlist), []);
  allowlist.installScripts[0].integrity = "sha512-different";
  assert.deepEqual(inspectManifest({}, lockfile, allowlist).map((item) => item.id), [
    "unreviewed-dependency-install-script",
  ]);
});

test("action provenance binds the allowlisted source to the referenced repository", () => {
  const reference = `trusted/example@${"a".repeat(40)}`;
  const allowlist = {
    schemaVersion: 1,
    actions: [
      {
        reference,
        version: "v1.0.0",
        source: "https://github.com/attacker/example",
        reason: "Mismatched source fixture.",
      },
    ],
    containers: [],
    workflows: [],
    installScripts: [],
  };

  assert.deepEqual(inspectAllowlist(allowlist).map((item) => item.id), [
    "invalid-action-allowlist-entry",
  ]);
  assert.deepEqual(
    inspectWorkflow(
      ".github/workflows/ci.yml",
      `on: push\njobs:\n  test:\n    steps:\n      - uses: ${reference}\n`,
      allowlist.actions,
    ).map((item) => item.id),
    ["unreviewed-action-reference"],
  );
});

test("candidate allowlist additions cannot self-authorize", () => {
  const base = { schemaVersion: 1, actions: [], containers: [], workflows: [], installScripts: [] };
  const candidate = {
    schemaVersion: 1,
    actions: [
      {
        reference: `trusted/example@${"a".repeat(40)}`,
        version: "v1.0.0",
        source: "https://github.com/trusted/example",
        reason: "Candidate-controlled entry.",
      },
    ],
    containers: [],
    workflows: [
      {
        path: ".github/workflows/extra.yml",
        sha256: "b".repeat(64),
        reason: "Candidate-controlled workflow digest.",
      },
    ],
    installScripts: [
      {
        path: "node_modules/example",
        version: "1.0.0",
        integrity: "sha512-YWJjZA==",
        reason: "Candidate-controlled entry.",
      },
    ],
  };

  assert.deepEqual(inspectAllowlist(candidate, base).map((item) => item.id), [
    "candidate-action-allowlist-expansion",
    "candidate-install-script-allowlist-expansion",
    "candidate-workflow-allowlist-expansion",
  ]);
});

test("workflow bytes must match a protected exact digest", () => {
  const body = "on: push\njobs: {}\n";
  const sha256 = "1c7b515b077ae3f96d2b4fc9e2be04d69213e4e0e941e382ac85b2bcfa8302af";
  const allowed = [
    {
      path: ".github/workflows/example.yml",
      sha256,
      reason: "Reviewed workflow fixture.",
    },
  ];
  assert.deepEqual(inspectWorkflowIntegrity(".github/workflows/example.yml", body, allowed), []);
  assert.deepEqual(
    inspectWorkflowIntegrity(
      ".github/workflows/example.yml",
      body.replaceAll("\n", "\r\n"),
      allowed,
    ),
    [],
  );
  assert.deepEqual(
    inspectWorkflowIntegrity(".github/workflows/example.yml", `${body}# changed\n`, allowed).map(
      (item) => item.id,
    ),
    ["unreviewed-workflow-content"],
  );
});

test("pull request workflows require immutable actions and no persisted credentials", () => {
  const findings = inspectWorkflow(
    ".github/workflows/ci.yml",
    "on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n",
  );

  assert.deepEqual(
    findings.map((item) => item.id).sort(),
    ["mutable-action-reference", "persisted-checkout-credential"],
  );
});

test("SHA-pinned read-only fork CI passes", () => {
  const reference = `actions/checkout@${"a".repeat(40)}`;
  const workflow = `on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: ${reference}\n        with:\n          persist-credentials: false\n      - run: npm ci --ignore-scripts\n`;

  assert.deepEqual(
    inspectWorkflow(".github/workflows/ci.yml", workflow, [
      {
        reference,
        version: "v1.0.0",
        source: "https://github.com/actions/checkout",
        reason: "Reviewed test fixture.",
      },
    ]),
    [],
  );
});

test("an immutable but unreviewed action identity is rejected", () => {
  const workflow = `on: push\njobs:\n  test:\n    steps:\n      - uses: attacker/example@${"b".repeat(40)}\n`;

  assert.deepEqual(inspectWorkflow(".github/workflows/automation.yml", workflow).map((item) => item.id), [
    "unreviewed-action-reference",
  ]);
});

test("local composite actions are rejected instead of bypassing nested dependency review", () => {
  const workflow = `on: push\njobs:\n  test:\n    steps:\n      - uses: ./.github/actions/helper\n`;

  assert.deepEqual(inspectWorkflow(".github/workflows/ci.yml", workflow).map((item) => item.id), [
    "local-action-reference",
  ]);
});

test("inline privileged fork triggers, secrets, write permission, and event shell interpolation fail", () => {
  const workflow = `on: ["pull_request", "pull_request_target"]\npermissions: {contents: write}\njobs:\n  test:\n    runs-on: \${{ matrix.runner }}\n    strategy:\n      matrix: {runner: [self-hosted]}\n    env:\n      TOKEN: \${{ secrets['TOKEN'] }}\n    steps:\n      - run: echo \"\${{ github.head_ref }}\"\n`;
  const ids = inspectWorkflow(".github/workflows/ci.yml", workflow).map((item) => item.id);

  for (const id of [
    "privileged-pull-request-trigger",
    "pull-request-secret",
    "pull-request-permission-contract",
    "pull-request-hosted-runner",
    "event-data-shell-injection",
  ]) {
    assert.ok(ids.includes(id), `expected ${id}`);
  }
});

test("pull request workflows require explicit least privilege", () => {
  const workflow = `on: pull_request\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo safe\n`;

  assert.deepEqual(inspectWorkflow(".github/workflows/ci.yml", workflow).map((item) => item.id), [
    "pull-request-permission-contract",
  ]);
});

test("whole secret contexts, GitHub tokens, and workflow-run privilege bridges are rejected", () => {
  const privileged = `on: workflow_run\njobs:\n  privileged:\n    runs-on: ubuntu-latest\n    steps: []\n`;
  assert.deepEqual(inspectWorkflow(".github/workflows/privileged.yml", privileged).map((item) => item.id), [
    "privileged-workflow-run-trigger",
  ]);

  for (const expression of [
    "toJSON(secrets)",
    "github.token",
    "github['token']",
    "toJSON(github)",
  ]) {
    const workflow = `on: pull_request\npermissions: {contents: read}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    env:\n      VALUE: \${{ ${expression} }}\n    steps:\n      - run: echo safe\n`;
    assert.ok(
      inspectWorkflow(".github/workflows/ci.yml", workflow).some(
        (item) => item.id === "pull-request-secret",
      ),
      `expected ${expression} to be rejected`,
    );
  }

  const runContext = `on: pull_request\npermissions: {contents: read}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo \"\${{ toJSON(github) }}\"\n`;
  assert.ok(
    inspectWorkflow(".github/workflows/ci.yml", runContext).some(
      (item) => item.id === "event-data-shell-injection",
    ),
  );
});

test("npm install script disabling cannot be hidden in a comment or set false", () => {
  for (const command of ["npm ci # --ignore-scripts", "npm ci --ignore-scripts=false"]) {
    const workflow = `on: pull_request\npermissions: {contents: read}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${command}\n`;
    assert.ok(
      inspectWorkflow(".github/workflows/ci.yml", workflow).some(
        (item) => item.id === "pull-request-install-scripts",
      ),
    );
  }
});

test("workflow containers require an exact reviewed digest", () => {
  const digest = "a".repeat(64);
  const mutable = `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    container: node:24\n    steps: []\n`;
  const pinned = `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    container: node:24@sha256:${digest}\n    steps: []\n`;

  assert.deepEqual(inspectWorkflow(".github/workflows/ci.yml", mutable).map((item) => item.id), [
    "workflow-container-forbidden",
    "mutable-container-image",
  ]);
  assert.deepEqual(inspectWorkflow(".github/workflows/ci.yml", pinned).map((item) => item.id), [
    "workflow-container-forbidden",
    "unreviewed-container-image",
  ]);
  assert.deepEqual(
    inspectWorkflow(".github/workflows/ci.yml", pinned, [], [
      {
        reference: `node:24@sha256:${digest}`,
        source: "https://hub.docker.com/_/node",
        reason: "Reviewed test fixture.",
      },
    ]),
    [
      {
        id: "workflow-container-forbidden",
        path: ".github/workflows/ci.yml",
        message:
          "Workflow job and service containers are forbidden because their mounts, credentials, and runtime options are a second host-capability surface.",
      },
    ],
  );
});

test("workflow job and service container options cannot expose the host", () => {
  const digest = "a".repeat(64);
  const workflow = `on: pull_request\npermissions: {contents: read}\njobs:\n  test:\n    runs-on: ubuntu-latest\n    container:\n      image: node:24@sha256:${digest}\n      options: --privileged\n      volumes:\n        - /:/host\n    services:\n      helper:\n        image: node:24@sha256:${digest}\n        options: --pid host\n    steps: []\n`;
  assert.ok(
    inspectWorkflow(".github/workflows/ci.yml", workflow).some(
      (item) => item.id === "workflow-container-forbidden",
    ),
  );
});

test("docker run commands require a reviewed digest and network-denied read-only isolation", () => {
  const reference = `docker.io/library/node:24@sha256:${"a".repeat(64)}`;
  const allowed = [
    {
      reference,
      source: "https://hub.docker.com/_/node",
      reason: "Reviewed test fixture.",
    },
  ];
  const safe = `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges ${reference} node --version\n`;
  assert.deepEqual(
    inspectWorkflow(".github/workflows/container.yml", safe, [], allowed).map((item) => item.id),
    ["workflow-container-command-forbidden"],
  );

  const unsafe = `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker run --privileged node:latest node --version\n`;
  const ids = inspectWorkflow(".github/workflows/container.yml", unsafe).map((item) => item.id);
  for (const id of [
    "ambiguous-docker-run-image",
    "docker-run-isolation",
    "docker-run-capabilities",
    "docker-run-host-capability",
  ]) {
    assert.ok(ids.includes(id), id);
  }
});

test("alternate container-engine commands cannot bypass docker run policy", () => {
  for (const command of [
    "docker container run node:latest node --version",
    "docker --host tcp://daemon.invalid run node:latest node --version",
    "docker-compose run node:latest node --version",
    "podman run node:latest node --version",
    "nerdctl run node:latest node --version",
  ]) {
    const workflow = `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: ${command}\n`;
    assert.ok(
      inspectWorkflow(".github/workflows/container.yml", workflow).some(
        (item) => item.id === "noncanonical-container-command",
      ),
      `expected alternate container command to fail: ${command}`,
    );
  }
});

test("non-release workflows cannot bind host paths into shell-launched containers", () => {
  const reference = `docker.io/library/node:24@sha256:${"a".repeat(64)}`;
  const workflow = `on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --volume /:/host:rw ${reference} node --version\n`;
  assert.ok(
    inspectWorkflow(".github/workflows/extra.yml", workflow, [], [
      {
        reference,
        source: "https://hub.docker.com/_/node",
        reason: "Reviewed test fixture.",
      },
    ]).some((item) => item.id === "workflow-container-command-forbidden"),
  );
});

test("release build code cannot share the final packaging tree", () => {
  const vulnerable = `on: push\njobs:\n  package:\n    runs-on: ubuntu-latest\n    steps:\n      - run: |\n          docker run --rm --network none --read-only node:latest sh -c 'npm run build; npm pack --ignore-scripts'\n`;
  assert.ok(
    inspectWorkflow(".github/workflows/release.yml", vulnerable).some(
      (item) => item.id === "release-build-pack-boundary",
    ),
  );
});

test("release containers reject extra writable host mounts", () => {
  const release = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const poisoned = release.replace(
    '            --volume "$RUNNER_TEMP/compiled-output:/compiled:rw" \\\n',
    '            --volume "$RUNNER_TEMP/compiled-output:/compiled:rw" \\\n            --volume "/:/host:rw" \\\n',
  );
  assert.notEqual(poisoned, release, "test mutation must alter the release workflow");
  assert.ok(
    inspectWorkflow(".github/workflows/release.yml", poisoned).some(
      (item) => item.id === "release-container-capability-surface",
    ),
  );

  const redirectedDaemon = release.replace(
    "    env:\n      npm_config_cache: .npm-cache\n",
    "    env:\n      npm_config_cache: .npm-cache\n      DOCKER_HOST: tcp://daemon.invalid\n",
  );
  assert.notEqual(redirectedDaemon, release, "test mutation must alter the release workflow");
  assert.ok(
    inspectWorkflow(".github/workflows/release.yml", redirectedDaemon).some(
      (item) => item.id === "release-container-capability-surface",
    ),
  );
});

test("tracked symlinks and submodules are rejected", () => {
  const findings = inspectTrackedEntries([
    { mode: "100644", path: "README.md" },
    { mode: "120000", path: "linked-config" },
    { mode: "160000", path: "vendor/repository" },
  ]);

  assert.deepEqual(findings.map((item) => item.id), ["tracked-symlink", "git-submodule"]);
});

test("repository npm configuration disables lifecycle scripts by default", () => {
  assert.deepEqual(inspectNpmConfiguration("ignore-scripts=true\n"), []);
  assert.deepEqual(inspectNpmConfiguration("").map((item) => item.id), [
    "npm-install-scripts-enabled",
  ]);
  assert.deepEqual(
    inspectNpmConfiguration("ignore-scripts=true\nignore-scripts=false\n").map((item) => item.id),
    ["npm-install-scripts-enabled"],
  );
});
