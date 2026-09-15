#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IMPLICIT_PACKAGE_LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
  "preprepare",
  "prepare",
  "postprepare",
  "prepack",
  "postpack",
  "preversion",
  "version",
  "postversion",
  "preuninstall",
  "uninstall",
  "postuninstall",
  "dependencies",
]);
const DEPENDENCY_FIELDS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];

function finding(id, path, message) {
  return { id, path, message };
}

function isRemoteOrLocalDependencySpec(spec) {
  return /^(?:https?:|git(?:\+[^:]+)?:|github:|gitlab:|bitbucket:|file:|link:)/i.test(spec);
}

function isExactRegistryVersion(spec) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(spec);
}

function expectedActionSource(reference) {
  const at = reference.lastIndexOf("@");
  const identity = at > 0 ? reference.slice(0, at) : reference;
  const [owner, repository] = identity.split("/");
  if (!owner || !repository) return undefined;
  return `https://github.com/${owner}/${repository}`;
}

function stableEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return JSON.stringify(entry);
  return JSON.stringify(
    Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right))),
  );
}

function isSafeNodeModulesPath(value) {
  if (typeof value !== "string" || !value.startsWith("node_modules/")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment && segment !== "." && segment !== "..");
}

export function inspectAllowlist(allowlist, trustedAllowlist) {
  const findings = [];
  if (
    !allowlist ||
    allowlist.schemaVersion !== 1 ||
    !Array.isArray(allowlist.actions) ||
    !Array.isArray(allowlist.containers) ||
    !Array.isArray(allowlist.workflows) ||
    !Array.isArray(allowlist.installScripts)
  ) {
    return [
      finding(
        "allowlist-contract",
        "supply-chain-allowlist.json",
        "The allowlist must use schemaVersion 1 with actions, containers, workflows, and installScripts arrays.",
      ),
    ];
  }

  const actionReferences = new Set();
  for (const entry of allowlist.actions) {
    const valid =
      entry &&
      typeof entry.reference === "string" &&
      /^[^/@]+\/[^/@]+(?:\/[^@]+)?@[a-f0-9]{40}$/.test(entry.reference) &&
      typeof entry.version === "string" &&
      entry.version.trim() &&
      entry.source === expectedActionSource(entry.reference) &&
      typeof entry.reason === "string" &&
      entry.reason.trim();
    if (!valid) {
      findings.push(
        finding(
          "invalid-action-allowlist-entry",
          "supply-chain-allowlist.json",
          "Every action entry must bind an exact GitHub owner/repository and commit SHA to its canonical source URL, release version, and rationale.",
        ),
      );
      continue;
    }
    if (actionReferences.has(entry.reference)) {
      findings.push(
        finding(
          "duplicate-action-allowlist-entry",
          "supply-chain-allowlist.json",
          `Duplicate action allowlist entry: ${entry.reference}`,
        ),
      );
    }
    actionReferences.add(entry.reference);
  }

  const containerReferences = new Set();
  for (const entry of allowlist.containers) {
    const valid =
      entry &&
      typeof entry.reference === "string" &&
      /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(entry.reference) &&
      typeof entry.source === "string" &&
      /^https:\/\/[^\s]+$/.test(entry.source) &&
      typeof entry.reason === "string" &&
      entry.reason.trim();
    if (!valid) {
      findings.push(
        finding(
          "invalid-container-allowlist-entry",
          "supply-chain-allowlist.json",
          "Every container entry must bind an exact registry image digest to an HTTPS provenance source and rationale.",
        ),
      );
      continue;
    }
    if (containerReferences.has(entry.reference)) {
      findings.push(
        finding(
          "duplicate-container-allowlist-entry",
          "supply-chain-allowlist.json",
          `Duplicate container allowlist entry: ${entry.reference}`,
        ),
      );
    }
    containerReferences.add(entry.reference);
  }

  const installPaths = new Set();
  for (const entry of allowlist.installScripts) {
    const valid =
      entry &&
      isSafeNodeModulesPath(entry.path) &&
      typeof entry.version === "string" &&
      isExactRegistryVersion(entry.version) &&
      typeof entry.integrity === "string" &&
      /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity) &&
      typeof entry.reason === "string" &&
      entry.reason.trim();
    if (!valid) {
      findings.push(
        finding(
          "invalid-install-script-allowlist-entry",
          "supply-chain-allowlist.json",
          "Every install-script entry must bind an exact node_modules path and version to a SHA-512 integrity value and rationale.",
        ),
      );
      continue;
    }
    if (installPaths.has(entry.path)) {
      findings.push(
        finding(
          "duplicate-install-script-allowlist-entry",
          "supply-chain-allowlist.json",
          `Duplicate install-script allowlist entry: ${entry.path}`,
        ),
      );
    }
    installPaths.add(entry.path);
  }

  const workflowEntries = new Set();
  for (const entry of allowlist.workflows) {
    const valid =
      entry &&
      typeof entry.path === "string" &&
      /^\.github\/workflows\/[A-Za-z0-9._-]+\.ya?ml$/.test(entry.path) &&
      typeof entry.sha256 === "string" &&
      /^[a-f0-9]{64}$/.test(entry.sha256) &&
      typeof entry.reason === "string" &&
      entry.reason.trim();
    if (!valid) {
      findings.push(
        finding(
          "invalid-workflow-allowlist-entry",
          "supply-chain-allowlist.json",
          "Every workflow entry must bind a direct .github/workflows YAML path to an exact SHA-256 digest and rationale.",
        ),
      );
      continue;
    }
    const key = `${entry.path}:${entry.sha256}`;
    if (workflowEntries.has(key)) {
      findings.push(
        finding(
          "duplicate-workflow-allowlist-entry",
          "supply-chain-allowlist.json",
          `Duplicate workflow allowlist entry: ${key}`,
        ),
      );
    }
    workflowEntries.add(key);
  }

  if (trustedAllowlist) {
    const trustedActions = new Set((trustedAllowlist.actions ?? []).map(stableEntry));
    const trustedContainers = new Set((trustedAllowlist.containers ?? []).map(stableEntry));
    const trustedWorkflows = new Set((trustedAllowlist.workflows ?? []).map(stableEntry));
    const trustedInstallScripts = new Set((trustedAllowlist.installScripts ?? []).map(stableEntry));
    for (const entry of allowlist.actions) {
      if (trustedActions.has(stableEntry(entry))) continue;
      findings.push(
        finding(
          "candidate-action-allowlist-expansion",
          "supply-chain-allowlist.json",
          `A candidate PR cannot authorize its own action entry: ${String(entry?.reference)}`,
        ),
      );
    }
    for (const entry of allowlist.containers) {
      if (trustedContainers.has(stableEntry(entry))) continue;
      findings.push(
        finding(
          "candidate-container-allowlist-expansion",
          "supply-chain-allowlist.json",
          `A candidate PR cannot authorize its own container entry: ${String(entry?.reference)}`,
        ),
      );
    }
    for (const entry of allowlist.installScripts) {
      if (trustedInstallScripts.has(stableEntry(entry))) continue;
      findings.push(
        finding(
          "candidate-install-script-allowlist-expansion",
          "supply-chain-allowlist.json",
          `A candidate PR cannot authorize its own install-script entry: ${String(entry?.path)}`,
        ),
      );
    }
    for (const entry of allowlist.workflows) {
      if (trustedWorkflows.has(stableEntry(entry))) continue;
      findings.push(
        finding(
          "candidate-workflow-allowlist-expansion",
          "supply-chain-allowlist.json",
          `A candidate PR cannot authorize its own workflow digest: ${String(entry?.path)}:${String(entry?.sha256)}`,
        ),
      );
    }
  }

  return findings;
}

export function inspectWorkflowIntegrity(path, body, allowedWorkflows = []) {
  const normalizedBody = body.replace(/\r\n?/g, "\n");
  const sha256 = createHash("sha256").update(normalizedBody).digest("hex");
  const reviewed = allowedWorkflows.some(
    (entry) => entry && entry.path === path && entry.sha256 === sha256,
  );
  return reviewed
    ? []
    : [
        finding(
          "unreviewed-workflow-content",
          path,
          `Workflow bytes are not pre-authorized by the protected baseline (sha256:${sha256}).`,
        ),
      ];
}

export function inspectManifest(manifest, lockfile, allowlist = { installScripts: [] }) {
  const findings = [];

  if (!lockfile || lockfile.lockfileVersion !== 3 || !lockfile.packages) {
    findings.push(
      finding(
        "lockfile-contract",
        "npm-shrinkwrap.json",
        "A published npm shrinkwrapVersion 3 file with package integrity metadata is required.",
      ),
    );
    return findings;
  }

  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (IMPLICIT_PACKAGE_LIFECYCLE_SCRIPTS.has(name)) {
      findings.push(
        finding(
          "root-install-script",
          "package.json",
          `Implicit root lifecycle script ${name} can execute during install, Git dependency preparation, or packaging: ${String(command)}`,
        ),
      );
    }
  }

  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
      const value = String(spec).trim();
      if (isRemoteOrLocalDependencySpec(value)) {
        findings.push(
          finding(
            "non-registry-dependency",
            "package.json",
            `${field}.${name} uses a Git, URL, or local-path dependency instead of the integrity-locked npm registry.`,
          ),
        );
        continue;
      }
      if (value === "*" || value === "latest") {
        findings.push(
          finding(
            "unbounded-dependency-version",
            "package.json",
            `${field}.${name} must not use an unbounded dependency version.`,
          ),
        );
      }
      if ((field === "dependencies" || field === "optionalDependencies") && !isExactRegistryVersion(value)) {
        findings.push(
          finding(
            "unpinned-production-dependency",
            "package.json",
            `${field}.${name} must use an exact registry version; the published shrinkwrap pins the transitive graph.`,
          ),
        );
      }
    }
  }

  const allowedInstallScripts = new Map(
    (allowlist.installScripts ?? []).map((entry) => [entry.path, entry]),
  );
  const observedInstallScripts = new Set();

  for (const [path, entry] of Object.entries(lockfile.packages)) {
    if (!path || !path.startsWith("node_modules/") || !entry || typeof entry !== "object") continue;
    if (!entry.resolved) {
      findings.push(
        finding(
          "missing-package-resolution",
          "npm-shrinkwrap.json",
          `${path} has no exact registry artifact resolution.`,
        ),
      );
    } else if (!String(entry.resolved).startsWith("https://registry.npmjs.org/")) {
      findings.push(
        finding(
          "non-registry-lock-entry",
          "npm-shrinkwrap.json",
          `${path} resolves outside the npm registry: ${String(entry.resolved)}`,
        ),
      );
    }
    if (entry.resolved && !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(String(entry.integrity ?? ""))) {
      findings.push(
        finding(
          "missing-package-integrity",
          "npm-shrinkwrap.json",
          `${path} has a resolved artifact without a SHA-512 integrity hash.`,
        ),
      );
    }
    if (entry.hasInstallScript) {
      observedInstallScripts.add(path);
      const allowed = allowedInstallScripts.get(path);
      if (
        allowed &&
        allowed.version === entry.version &&
        allowed.integrity === entry.integrity &&
        typeof allowed.reason === "string" &&
        allowed.reason.trim()
      ) {
        continue;
      }
      findings.push(
        finding(
          "unreviewed-dependency-install-script",
          "supply-chain-allowlist.json",
          `${path}@${String(entry.version)} has an install lifecycle script without an exact version and integrity allowlist entry.`,
        ),
      );
    }
  }

  for (const path of allowedInstallScripts.keys()) {
    if (observedInstallScripts.has(path)) continue;
    findings.push(
      finding(
        "stale-install-script-allowlist",
        "supply-chain-allowlist.json",
        `${path} is allowlisted but is not an install-script dependency in npm-shrinkwrap.json.`,
      ),
    );
  }

  return findings;
}

function visitObjects(value, callback) {
  if (Array.isArray(value)) {
    for (const item of value) visitObjects(item, callback);
    return;
  }
  if (!value || typeof value !== "object") return;
  callback(value);
  for (const child of Object.values(value)) visitObjects(child, callback);
}

function hasWorkflowEvent(events, name) {
  if (typeof events === "string") return events === name;
  if (Array.isArray(events)) return events.includes(name);
  return Boolean(events && typeof events === "object" && Object.hasOwn(events, name));
}

function workflowNodes(workflow) {
  const nodes = [];
  visitObjects(workflow, (value) => nodes.push(value));
  return nodes;
}

function workflowPermissionsAreReadOnly(value, requireContents) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (requireContents && value.contents !== "read") return false;
  return Object.values(value).every((permission) => permission === "read" || permission === "none");
}

function hostedRunnerIsLiteral(value) {
  return (
    typeof value === "string" &&
    /^(?:ubuntu|windows|macos)-(?:latest|\d+(?:\.\d+)?)$/.test(value)
  );
}

function containerImage(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.image === "string") return value.image;
  return undefined;
}

function unsafeNpmInstall(command) {
  return command.split(/\r?\n/).some((rawLine) => {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!/\bnpm\s+(?:ci|install)\b/.test(line)) return false;
    return !/^npm\s+(?:ci|install)\s+--ignore-scripts(?:=true)?$/.test(line);
  });
}

function normalizedDockerPrefix(command) {
  const normalized = command.replace(/\\\r?\n/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized.startsWith("docker run ")) return undefined;
  const match = normalized.match(
    /\bdocker run\s+(.*?)((?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9._/-]+(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64})(?:\s|$)/i,
  );
  return match ? `docker run ${match[1].trim()} <IMAGE>` : undefined;
}

export function inspectWorkflow(path, body, allowedActions = [], allowedContainers = []) {
  const findings = [];
  const workflow = parseYaml(body, { maxAliasCount: 20 });
  if (!workflow || typeof workflow !== "object") {
    throw new Error(`${path} must contain a YAML object.`);
  }
  const nodes = workflowNodes(workflow);
  const actionSteps = nodes.filter((node) => typeof node.uses === "string");
  const actionReferences = actionSteps.map((node) => node.uses);
  const runCommands = nodes.filter((node) => typeof node.run === "string").map((node) => node.run);
  const pullRequestWorkflow = hasWorkflowEvent(workflow.on, "pull_request");
  const jobs = workflow.jobs && typeof workflow.jobs === "object" ? Object.values(workflow.jobs) : [];
  const releaseWorkflow =
    path.endsWith("/.github/workflows/release.yml") || path === ".github/workflows/release.yml";
  const declarativeWorkflowContainers = jobs.some(
    (job) =>
      job &&
      typeof job === "object" &&
      (job.container !== undefined ||
        (job.services && typeof job.services === "object" && Object.keys(job.services).length > 0)),
  );
  if (declarativeWorkflowContainers) {
    findings.push(
      finding(
        "workflow-container-forbidden",
        path,
        "Workflow job and service containers are forbidden because their mounts, credentials, and runtime options are a second host-capability surface.",
      ),
    );
  }

  if (releaseWorkflow) {
    const buildCommands = runCommands.filter((command) => /\bnpm\s+run\s+build\b/.test(command));
    const packCommands = runCommands.filter((command) => /\bnpm\s+pack\b/.test(command));
    const build = buildCommands[0] ?? "";
    const pack = packCommands[0] ?? "";
    const expectedDockerPrefixes = new Set([
      'docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --env HOME=/tmp/home --env npm_config_cache=/tmp/npm-cache --tmpfs /build:rw,exec,size=3g --tmpfs /tmp:rw,noexec,size=256m --volume "$GITHUB_WORKSPACE:/source:ro" --volume "$RUNNER_TEMP/compiled-output:/compiled:rw" <IMAGE>',
      'docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --env HOME=/tmp/home --env npm_config_cache=/tmp/npm-cache --tmpfs /build:rw,exec,size=3g --tmpfs /tmp:rw,noexec,size=256m --volume "$GITHUB_WORKSPACE:/source:ro" --volume "$RUNNER_TEMP/compiled-output:/compiled:ro" --volume "$RUNNER_TEMP/package-output:/output:rw" <IMAGE>',
      'docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --env HOME=/tmp/home --tmpfs /tmp:rw,exec,size=2g --volume "$GITHUB_WORKSPACE:/source:ro" --volume "$RUNNER_TEMP/package-consumer:/consumer:rw" <IMAGE>',
    ]);
    const dockerPrefixes = runCommands
      .filter((command) => /\bdocker\s+run\b/.test(command))
      .map(normalizedDockerPrefix);
    const releaseDockerEnvironmentOverride = nodes.some(
      (node) =>
        node.env &&
        typeof node.env === "object" &&
        Object.keys(node.env).some((name) =>
          ["docker_host", "docker_context", "docker_config", "container_host"].includes(
            name.toLowerCase(),
          ),
        ),
    );
    const exactDockerSurface =
      dockerPrefixes.length === expectedDockerPrefixes.size &&
      dockerPrefixes.every((prefix) => prefix && expectedDockerPrefixes.has(prefix)) &&
      !releaseDockerEnvironmentOverride &&
      jobs.every(
        (job) =>
          !job ||
          typeof job !== "object" ||
          (job.container === undefined && job.services === undefined),
      );
    const separated =
      buildCommands.length === 1 &&
      packCommands.length === 1 &&
      build !== pack &&
      /--volume\s+"?\$GITHUB_WORKSPACE:\/source:ro"?/.test(build) &&
      /--volume\s+"?\$RUNNER_TEMP\/compiled-output:\/compiled:rw"?/.test(build) &&
      !/package-output:\/output:rw/.test(build) &&
      /--volume\s+"?\$GITHUB_WORKSPACE:\/source:ro"?/.test(pack) &&
      /--volume\s+"?\$RUNNER_TEMP\/compiled-output:\/compiled:ro"?/.test(pack) &&
      /--volume\s+"?\$RUNNER_TEMP\/package-output:\/output:rw"?/.test(pack) &&
      /npm\s+pack\s+--ignore-scripts\b/.test(pack) &&
      /npm\s+sbom\s+--package-lock-only\s+--sbom-format\s+cyclonedx\b/.test(pack) &&
      /cp\s+-a\s+\/compiled\/dist\/\.\s+\/build\/project\/dist\//.test(pack);
    if (!separated) {
      findings.push(
        finding(
          "release-build-pack-boundary",
          path,
          "Release builds must export only dist, terminate, then pack fresh source in a separate network-disabled container without candidate-writable package output.",
        ),
      );
    }
    if (!exactDockerSurface) {
      findings.push(
        finding(
          "release-container-capability-surface",
          path,
          "Release containers must use only the exact reviewed mounts, environment, tmpfs, dropped capabilities, and network-denied options for build, pack, and verification.",
        ),
      );
    }
  }

  const reviewedActions = new Set(
    allowedActions
      .filter(
        (entry) =>
          typeof entry.reference === "string" &&
          typeof entry.version === "string" &&
          typeof entry.reason === "string" &&
          entry.reason.trim() &&
          typeof entry.source === "string" &&
          entry.source === expectedActionSource(entry.reference),
      )
      .map((entry) => entry.reference),
  );
  const reviewedContainers = new Set(
    allowedContainers
      .filter(
        (entry) =>
          typeof entry.reference === "string" &&
          /^[^\s@]+@sha256:[a-f0-9]{64}$/.test(entry.reference) &&
          typeof entry.source === "string" &&
          entry.source.startsWith("https://") &&
          typeof entry.reason === "string" &&
          entry.reason.trim(),
      )
      .map((entry) => entry.reference),
  );

  for (const reference of actionReferences) {
    if (reference.startsWith("./")) {
      findings.push(
        finding(
          "local-action-reference",
          path,
          `Local Actions are forbidden because nested action manifests are a second executable dependency surface: ${reference}`,
        ),
      );
      continue;
    }
    const at = reference.lastIndexOf("@");
    const immutable = at > 0 && /^[a-f0-9]{40}$/.test(reference.slice(at + 1));
    const digestPinnedContainer = /^docker:\/\/[^@]+@sha256:[a-f0-9]{64}$/.test(reference);
    if (!immutable && !digestPinnedContainer) {
      findings.push(
        finding(
          "mutable-action-reference",
          path,
          `GitHub Action reference must use a full immutable commit SHA: ${reference}`,
        ),
      );
      continue;
    }
    if (!reviewedActions.has(reference)) {
      findings.push(
        finding(
          "unreviewed-action-reference",
          path,
          `GitHub Action is immutable but has no exact provenance allowlist entry: ${reference}`,
        ),
      );
    }
  }

  const containerReferences = jobs.flatMap((job) => {
    if (!job || typeof job !== "object") return [];
    const references = [containerImage(job.container)];
    if (job.services && typeof job.services === "object") {
      references.push(...Object.values(job.services).map(containerImage));
    }
    return references.filter(Boolean);
  });
  for (const reference of containerReferences) {
    if (!/^[^\s@]+@sha256:[a-f0-9]{64}$/.test(reference)) {
      findings.push(
        finding(
          "mutable-container-image",
          path,
          `Workflow container images must use an immutable SHA-256 digest: ${reference}`,
        ),
      );
    } else if (!reviewedContainers.has(reference)) {
      findings.push(
        finding(
          "unreviewed-container-image",
          path,
          `Workflow container image has no exact provenance allowlist entry: ${reference}`,
        ),
      );
    }
  }

  for (const command of runCommands) {
    const alternateContainerCommands =
      command.match(
        /\b(?:docker\s+(?!run\b)\S+|docker-compose\s+\S+|podman\s+\S+|nerdctl\s+\S+|buildah\s+\S+|ctr\s+\S+)\b/g,
      ) ?? [];
    for (const reference of alternateContainerCommands) {
      findings.push(
        finding(
          "noncanonical-container-command",
          path,
          `Container-engine commands must use the reviewed canonical docker run form: ${reference}`,
        ),
      );
    }
    const dockerRuns = command.match(/\bdocker\s+run\b/g) ?? [];
    if (dockerRuns.length === 0) continue;
    if (!releaseWorkflow) {
      findings.push(
        finding(
          "workflow-container-command-forbidden",
          path,
          "Container-engine shell commands are forbidden outside the exact release workflow capability profile.",
        ),
      );
    }
    const pinnedImages = [
      ...command.matchAll(
        /\b(?:[a-z0-9.-]+(?::\d+)?\/)?[a-z0-9._/-]+(?::[a-z0-9._-]+)?@sha256:[a-f0-9]{64}\b/gi,
      ),
    ].map((match) => match[0]);
    if (dockerRuns.length !== 1 || pinnedImages.length !== 1) {
      findings.push(
        finding(
          "ambiguous-docker-run-image",
          path,
          "Each Docker run step must launch exactly one digest-pinned image so provenance is unambiguous.",
        ),
      );
    }
    for (const reference of pinnedImages) {
      if (reviewedContainers.has(reference)) continue;
      findings.push(
        finding(
          "unreviewed-container-image",
          path,
          `Docker run image has no exact provenance allowlist entry: ${reference}`,
        ),
      );
    }
    if (!/--network(?:=|\s+)none\b/.test(command) || !/(?:^|\s)--read-only(?:\s|\\|$)/m.test(command)) {
      findings.push(
        finding(
          "docker-run-isolation",
          path,
          "Docker run steps must disable networking and use a read-only root filesystem.",
        ),
      );
    }
    if (!/--cap-drop(?:=|\s+)ALL\b/.test(command) || !/--security-opt(?:=|\s+)no-new-privileges\b/.test(command)) {
      findings.push(
        finding(
          "docker-run-capabilities",
          path,
          "Docker run steps must drop every Linux capability and enable no-new-privileges.",
        ),
      );
    }
    if (/--privileged\b|docker\.sock/.test(command)) {
      findings.push(
        finding(
          "docker-run-host-capability",
          path,
          "Docker run steps must not receive privileged mode or a container-engine socket.",
        ),
      );
    }
  }

  if (hasWorkflowEvent(workflow.on, "pull_request_target")) {
    findings.push(
      finding(
        "privileged-pull-request-trigger",
        path,
        "pull_request_target is forbidden because it creates a privileged path from fork-controlled input.",
      ),
    );
  }
  if (hasWorkflowEvent(workflow.on, "workflow_run")) {
    findings.push(
      finding(
        "privileged-workflow-run-trigger",
        path,
        "workflow_run is forbidden because it can turn fork-produced artifacts or refs into privileged execution.",
      ),
    );
  }

  if (!pullRequestWorkflow) return findings;

  if (
    /\$\{\{[^}]*\bsecrets\b/.test(body) ||
    /\$\{\{[^}]*\bgithub\s*(?:\.token|\[\s*["']token["']\s*\])/.test(body) ||
    /\$\{\{[^}]*(?:\btoJSON\s*\(\s*github\s*\)|\bgithub\s*(?=\}\}))/i.test(body) ||
    jobs.some((job) => job?.secrets !== undefined)
  ) {
    findings.push(
      finding(
        "pull-request-secret",
        path,
        "A pull_request workflow must not reference repository or environment secrets.",
      ),
    );
  }
  const jobPermissionOverrideUnsafe = jobs.some(
    (job) =>
      job &&
      typeof job === "object" &&
      Object.hasOwn(job, "permissions") &&
      !workflowPermissionsAreReadOnly(job.permissions, false),
  );
  if (!workflowPermissionsAreReadOnly(workflow.permissions, true) || jobPermissionOverrideUnsafe) {
    findings.push(
      finding(
        "pull-request-permission-contract",
        path,
        "A pull_request workflow must explicitly grant top-level contents: read, grant no write scope, and keep every job override read-only.",
      ),
    );
  }
  const unsafeRunners = jobs.filter(
    (job) =>
      job &&
      typeof job === "object" &&
      typeof job.uses !== "string" &&
      !hostedRunnerIsLiteral(job["runs-on"]),
  );
  if (unsafeRunners.length > 0) {
    findings.push(
      finding(
        "pull-request-hosted-runner",
        path,
        "Fork-controlled jobs must use a literal GitHub-hosted ubuntu, windows, or macos runner; expressions, matrices, and self-hosted labels are forbidden.",
      ),
    );
  }
  if (runCommands.some((command) => /\$\{\{[^}]*\bgithub\b/.test(command))) {
    findings.push(
      finding(
        "event-data-shell-injection",
        path,
        "Do not interpolate GitHub context values directly into a run step; pass reviewed values through an environment variable.",
      ),
    );
  }

  const unsafeCheckout = actionSteps.some(
    (step) =>
      step.uses.startsWith("actions/checkout@") &&
      step.with?.["persist-credentials"] !== false &&
      step.with?.["persist-credentials"] !== "false",
  );
  if (unsafeCheckout) {
    findings.push(
      finding(
        "persisted-checkout-credential",
        path,
        "Every pull_request checkout must set persist-credentials: false.",
      ),
    );
  }

  const npmConfigOverride = nodes.some(
    (node) =>
      node.env &&
      typeof node.env === "object" &&
      Object.entries(node.env).some(
        ([name, value]) =>
          name.toLowerCase() === "npm_config_ignore_scripts" && value !== true && value !== "true",
      ),
  );
  for (const command of runCommands) {
    if (unsafeNpmInstall(command) || npmConfigOverride) {
      findings.push(
        finding(
          "pull-request-install-scripts",
          path,
          "Dependency installation in pull_request workflows must be an exact npm ci/install --ignore-scripts command with no false configuration override.",
        ),
      );
      break;
    }
  }

  return findings;
}

export function inspectTrackedEntries(entries) {
  const findings = [];
  for (const entry of entries) {
    if (entry.mode === "120000") {
      findings.push(
        finding(
          "tracked-symlink",
          entry.path,
          "Tracked symbolic links are forbidden because their target can escape an expected review boundary.",
        ),
      );
    }
    if (entry.mode === "160000") {
      findings.push(
        finding(
          "git-submodule",
          entry.path,
          "Git submodules are forbidden because their referenced content is not covered by this repository lockfile.",
        ),
      );
    }
  }
  return findings;
}

export function inspectNpmConfiguration(body) {
  const enabled = body.replaceAll("\r\n", "\n") === "ignore-scripts=true\n";
  return enabled
    ? []
    : [
        finding(
          "npm-install-scripts-enabled",
          ".npmrc",
          "Repository installs must default to ignore-scripts=true.",
        ),
      ];
}

function trackedEntries(root) {
  const result = spawnSync("git", ["ls-files", "-s", "-z"], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.toString("utf8").trim());
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d+) [a-f0-9]+ \d+\t(.+)$/.exec(record);
      if (!match) throw new Error(`Cannot parse tracked Git entry: ${record}`);
      return { mode: match[1], path: match[2] };
    });
}

function workflowFiles(root) {
  const directory = join(root, ".github", "workflows");
  if (!lstatSync(directory).isDirectory()) {
    throw new Error(".github/workflows must be a real directory, not a symbolic link.");
  }
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => join(directory, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function readRegularFile(root, path) {
  const file = join(root, path);
  if (!lstatSync(file).isFile()) throw new Error(`${path} must be a regular file.`);
  return readFileSync(file, "utf8");
}

export function inspectRepository(root = DEFAULT_ROOT, trustedAllowlist) {
  const entries = trackedEntries(root);
  const entryFindings = inspectTrackedEntries(entries);
  if (entryFindings.length > 0) return entryFindings;
  const manifest = JSON.parse(readRegularFile(root, "package.json"));
  const lockfile = JSON.parse(readRegularFile(root, "npm-shrinkwrap.json"));
  const allowlist = JSON.parse(readRegularFile(root, "supply-chain-allowlist.json"));
  const npmrcPath = join(root, ".npmrc");
  const findings = [
    ...inspectAllowlist(allowlist, trustedAllowlist),
    ...inspectManifest(manifest, lockfile, allowlist),
    ...inspectNpmConfiguration(existsSync(npmrcPath) ? readFileSync(npmrcPath, "utf8") : ""),
  ];
  const observedWorkflowPaths = new Set();
  for (const file of workflowFiles(root)) {
    const path = relative(root, file).split("\\").join("/");
    const body = readFileSync(file, "utf8");
    observedWorkflowPaths.add(path);
    findings.push(
      ...inspectWorkflowIntegrity(path, body, allowlist.workflows),
      ...inspectWorkflow(
        path,
        body,
        allowlist.actions,
        allowlist.containers,
      ),
    );
  }
  for (const path of new Set(allowlist.workflows.map((entry) => entry?.path).filter(Boolean))) {
    if (observedWorkflowPaths.has(path)) continue;
    findings.push(
      finding(
        "missing-reviewed-workflow",
        path,
        "A workflow named by the protected allowlist is missing from the repository.",
      ),
    );
  }
  return findings.sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.path.localeCompare(right.path) ||
      left.message.localeCompare(right.message),
  );
}

function main() {
  try {
    const args = process.argv.slice(2);
    let root = DEFAULT_ROOT;
    let baselineRoot;
    if (args.length > 0) {
      for (let index = 0; index < args.length; index += 2) {
        const flag = args[index];
        const value = args[index + 1];
        if (!value || (flag !== "--root" && flag !== "--baseline-root")) {
          throw new Error(
            "Usage: check-supply-chain.mjs [--root <repository-root>] [--baseline-root <trusted-base-root>]",
          );
        }
        if (flag === "--root") root = resolve(value);
        if (flag === "--baseline-root") baselineRoot = resolve(value);
      }
    }
    const trustedAllowlist = baselineRoot
      ? JSON.parse(readRegularFile(baselineRoot, "supply-chain-allowlist.json"))
      : undefined;
    const findings = inspectRepository(root, trustedAllowlist);
    if (findings.length === 0) {
      console.log("Supply-chain contract passed (lockfile, install scripts, workflows, and Git object types).\n");
      return;
    }
    console.error("Supply-chain contract failed:");
    for (const item of findings) console.error(`- [${item.id}] ${item.path}: ${item.message}`);
    process.exitCode = 1;
  } catch (error) {
    console.error(`Supply-chain contract error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
