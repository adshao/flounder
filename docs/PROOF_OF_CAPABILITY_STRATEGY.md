# Proof-of-Capability Strategy

Status: strategic direction as of 2026-07-22. Time-sensitive target details must
be revalidated before a campaign starts.

## Executive Decision

Flounder should become a general-purpose, execution-grounded autonomous
vulnerability research system. It should not claim that position yet.

The immediate objective is narrower and more important: independently discover
a previously unknown vulnerability, reproduce it with attacker-real local
execution, submit it through an authorized disclosure path, and obtain an
external acceptance or fix. That complete loop is the next proof milestone.

The first wedge should not be "old and influential" versus "new and obscure."
It should be:

> A mature, high-impact system with fresh attack surface, a buildable public
> source tree, and a credible disclosure and reward path.

Fresh attack surface includes a release candidate, hard-fork implementation,
new module, protocol upgrade, bridge or application integration, deployment
change, dependency update, or previously unaudited component. This combines the
distribution and impact of a mature system with the bug density of new code.

## Current Evidence and the Missing Proof

Flounder already has a meaningful technical foundation:

- sealed Map and Dig discovery with resumable coverage;
- local executable and differential confirmation;
- independent refutation and faithful-PoC appeal;
- real-target reproduction through read-only data and local forks;
- novelty, scope, impact, and submission-readiness gates;
- replayable state, evaluation groups, and blind regression controls.

Historical incident reconstruction and known-vulnerability rediscovery are
valuable evidence that the machinery works. They are not evidence that Flounder
can independently find a novel issue before disclosure. Internal labels such as
`confirmed` or `submitted` are also not external validation.

The evidence ladder is:

1. Blind rediscovery of a known vulnerability in an answer-free fixture.
2. Previously unknown finding with an executable local PoC.
3. Reproduction against the real release or deployment on a local fork or
   isolated environment.
4. A submission-ready report that clears scope, novelty, impact, and duplicate
   checks.
5. Official acceptance, remediation, advisory, CVE/GHSA credit, or bounty.
6. Repeated accepted results across targets and, later, across security domains.

Stages 1-4 establish technical promise. Stage 5 is the first externally
credible proof. Stage 6 supports the broader product claim.

## Positioning

Use claims that match the available evidence:

- Now: **execution-grounded autonomous vulnerability research**.
- After the first accepted novel issue: **finds and proves previously unknown
  vulnerabilities**.
- After repeated Web3 results and at least one accepted non-Web3 result:
  **general-purpose autonomous security research system**.

Do not lead with "AI pentesting platform" or "universal vulnerability scanner."
Those claims broaden the comparison set before the product has established a
repeatable proof loop.

## Target Selection Is an Operator Strategy

Flounder's product kernel should remain target- and taxonomy-neutral. Target
selection belongs to an external campaign process that ranks candidates by
expected collectible value:

`probability of a real bug × probability of unique discovery × impact ×
probability of acceptance and payment ÷ total campaign cost`

The operator should score these independently:

- fresh code or changed assumptions;
- funds, users, privileges, or infrastructure at risk;
- public and buildable source with deterministic local confirmation;
- explicit bounty or responsive private disclosure path;
- clear scope, impact rules, and payment history;
- ability to reproduce without writing to a live system;
- competition density and evidence of prior review;
- time to build, run, minimize, confirm, and report.

### Target Matrix

| Target type | Discovery probability | External impact | Recommended use |
| --- | --- | --- | --- |
| Mature system with no meaningful recent change | Lower | High | Selective audit only when a neglected boundary or new evidence exists |
| New, low-adoption project | Higher | Low or uncertain | Cheap held-out evaluation, not the flagship proof campaign |
| Mature system with a fresh release, module, or integration | High enough | High | Primary proof campaign |
| Time-limited contest with public judging | Medium | Medium to high | Repeatability and comparative-performance lane |
| Recent exploited project | Known bug already public | Incident-dependent | Root-cause training and blind regression, not a novel finding claim |

Contest performance is useful because the judge is external and the denominator
is visible. It should be a second proof lane, not the only lane. Count unique,
officially judged valid findings, severity, rank, and payout; never use raw
submission volume as a success metric.

## Immediate Campaign: BNB Chain Pasteur

As of 2026-07-22, the strongest time-sensitive launch candidate is the BNB Smart
Chain Pasteur upgrade:

- BSC `v1.7.7` is the mainnet release for the Pasteur hard fork scheduled for
  2026-08-25, creating a short pre-mainnet review window.
- The release includes validator, block-builder, system-contract, state, RPC,
  tracing, reorganization, and race-related changes.
- BNB Chain publishes an official bug bounty with rewards up to USD 100,000 and
  explicitly includes the BSC client and `bsc-genesis-contract` among its
  targets.

Before starting, revalidate the release, fork schedule, exact in-scope
repositories and versions, exclusions, duplicate policy, and reward terms on
the [official releases page](https://www.bnbchain.org/en/releases) and
[official bounty page](https://bugbounty.bnbchain.org/).

Run independent but related campaigns instead of one unfocused repository-wide
pass:

1. BSC consensus, validator-set, and hard-fork transition behavior.
2. Builder-proposed block and `BidBlock` behavior.
3. State, reorganization, RPC, tracing, and concurrency changes.
4. `bsc-genesis-contract` release changes as a separate language, deployment,
   and state-transition campaign.

The campaign boundary is the changed release plus the surrounding components
needed to prove invariants. The model still owns the inventory, obligations,
attack paths, and tests. Use official answer-free design materials and diffs as
context; do not inject a hand-written list of suspected bugs.

All exploitation remains inside unit tests, local nodes, devnets, or local
forks. Never broadcast a transaction or write to a public network.

## What Recent BNB Incidents Teach

Recent BNB Smart Chain incidents show recurring failures in composed,
state-dependent asset accounting:

- The July 2026 BFB incident involved custom token transfer and price-defense
  behavior interacting with a liquidity pool. Public analyses describe repeated
  zero-value calls causing pair-side token burns, reserve synchronization, and
  extraction of approximately 350.6 WBNB. See the
  [Verichains analysis](https://blog.verichains.io/p/bfb-token-exploit-analysis)
  and [Anomly reconstruction](https://anomly.rs/bfb-zero-transfer-deflation-exploit-bsc).
- Public reporting attributes the July 2026 PHX loss to custom transfer-fee
  behavior interacting with AMM accounting. The public root-cause record is
  less authoritative, so treat it as an evaluation lead rather than settled
  ground truth. See the
  [incident report](https://www.cryptotimes.io/2026/07/13/phx-wbnb-liquidity-pool-drained-of-nearly-90k-in-bnb-chain-exploit/).
- The February 2026 STO incident similarly combined sell-time token behavior,
  pool reserve mutation, initialization state, and repeated synchronization.
  See the [Nomos Labs reconstruction](https://nomoslabs.io/archive/sto-2026).

The product lesson is not to add "deflationary token," `sync`, zero-transfer,
or Pancake-specific rules to Flounder's prompt. The general capability gap is
execution-driven discovery across stateful composition:

- generate and execute multi-operation sequences, not only single calls;
- explore identity, empty, zero, boundary, and repeated inputs when the model
  decides they are relevant;
- observe assets, liabilities, reserves, debt, supply, balances, privileges,
  and other model-selected state before and after each sequence;
- support conservation and differential properties across multiple components;
- snapshot, reset, fork, minimize, and replay a sequence deterministically;
- compare the vulnerable behavior with a control or candidate fix;
- bind source, build, bytecode, release, and deployment provenance.

BFB, PHX, and STO should become blind held-out incident regressions using
pre-disclosure source snapshots and answer-free materials. Post-mortems must not
be visible to the discovery model, and rediscovery must never be presented as a
novel result.

Small unaffiliated tokens are generally poor flagship targets when they lack a
declared scope, security contact, responsive maintainer, or credible payment
path. Their incidents are high-value capability signals but low-confidence
collection opportunities.

## Why Mature Targets Are Still Viable

"Already audited" is not equivalent to "exhausted." Systems change, prior
audits cover versions and scopes rather than all future behavior, and important
bugs often live at composition boundaries.

An Immunefi study of 593 programs reported that 93.9% of programs active for at
least five years had paid at least one critical report. This is platform-owned
research and should be treated as directional rather than neutral market
measurement, but it supports the recurrent-vulnerability thesis. See
[Immunefi's research](https://immunefi.com/blog/research/nearly-every-long-running-bug-bounty-program-on-immunefi-has-found-a-critical-bug/).

OpenZeppelin's bounty provides a useful target-pattern example: influential,
widely reviewed software with a continuing bounty, required PoCs, possible
GHSA/CVE credit, and a bonus for release-candidate findings during a declared
review window. See the
[OpenZeppelin bounty](https://immunefi.com/bug-bounty/openzeppelin/information/).

The operating rule is therefore:

> Follow change into high-impact systems; do not simply follow reputation or
> audit the oldest unchanged code again.

## Expansion Beyond Web3

Web3 is a strong initial proving ground because source is often public, impact
is legible, local forks can reproduce real state, and bounties provide an
external decision. It should remain the first wedge, not the permanent product
boundary.

Recent non-Web3 evidence reinforces two lessons:

- Mature software remains discoverable. Mozilla reported that an AI-assisted
  review of Firefox, despite more than twenty years of scrutiny, produced
  reproducible bugs that Mozilla engineers validated, including 14 high-severity
  issues and 22 CVEs. Minimal executable test cases were central to validation.
  See [Mozilla's report](https://blog.mozilla.org/en/firefox/hardening-firefox-anthropic-red-team/)
  and [client bounty rules](https://www.mozilla.org/en-US/security/client-bug-bounty/).
- Source review alone is insufficient for runtime protocol and identity flaws.
  CVE-2026-0257 was a critical GlobalProtect authentication-bypass issue reported
  as actively exploited, illustrating the importance of request sequences,
  deployed configuration, and authorization state. See the
  [Singapore CSA advisory](https://www.csa.gov.sg/alerts-and-advisories/alerts/al-2026-064/).
- Enterprise attack surfaces are dominated by HTTP, TCP, identity, middleware,
  and deployed-product behavior. Oracle's July 2026 Critical Patch Update lists
  large numbers of remotely exploitable fixes across application testing,
  E-Business Suite, and Fusion Middleware. See the
  [Oracle advisory](https://www.oracle.com/security-alerts/cpujul2026.html).

This implies three capability lanes:

1. **White-box code execution:** source, tests, sanitizers, fuzzing, local
   harnesses, and compiler/runtime instrumentation. This is Flounder's current
   strength and should expand naturally to C/C++, Rust, Go, Java, and other
   buildable targets.
2. **Authorized gray-box dynamic assessment:** stateful HTTP/API, browser,
   WebSocket, and network-protocol testing against a self-hosted or explicitly
   authorized environment.
3. **Operational authority assessment:** IAM, cloud configuration, CI/CD,
   package and update pipelines, signing, secrets, and supply-chain boundaries.
   This should follow only after the dynamic evidence model is proven.

Firefox is a valuable future flagship but not the easiest first non-Web3 win. A
credible Firefox campaign needs large C++ build support, sanitizers, fuzz
harnesses, crash minimization and deduplication, and multiprocess or sandbox
boundary testing. Begin with a self-hostable Web/API target that has an official
bounty or CVE path, then progress to browser-class targets.

## Dynamic Assessment: Required, but Bounded

Flounder is a white-hat system. "White-box" and "black-box" describe how much
target information is available; "white-hat" describes authorization and
purpose. These concepts must not be conflated.

The current product is primarily source-driven white-box research with local
dynamic confirmation and limited open-world read/fork/fetch capability. Generic
shell access lets a model construct some dynamic tests, but Flounder is not yet
a first-class black- or gray-box penetration-testing system.

Add dynamic capability as an **Authorized Dynamic Target**, not as a broad
"pentest mode" switch.

### Engagement Manifest

Require explicit, machine-enforced declarations for:

- allowed hosts, ports, protocols, paths, methods, and time window;
- allowed accounts, identities, tenants, roles, and test data;
- request rate and concurrency limits;
- prohibited actions and sensitive data;
- state reset, seed, and cleanup procedures;
- emergency contact and stop conditions;
- whether the target is local, self-hosted, staging, or production.

Production active testing should be denied by default and require explicit
authorization. Destructive behavior, persistence, real-user data access,
third-party pivoting, availability impact, credential theft, and rate-limit
bypass remain prohibited unless a narrowly defined authorized engagement
explicitly permits a safe equivalent in an isolated environment.

### Model-Callable Affordances

Provide bounded, auditable tools for:

- stateful HTTP request and response sequences;
- isolated cookie, token, and browser sessions;
- two or more controlled identities or tenants for authorization testing;
- browser actions and DOM/network observation;
- WebSocket and selected network-protocol interactions;
- HAR or equivalent capture, redaction, replay, and minimization;
- target snapshot, reset, seed, and deterministic fixture control.

These are capabilities, not injected testing strategies. The model chooses how
to use them inside the engagement boundary.

### Dynamic Evidence Contract

A confirmed dynamic finding must include:

- an exact, replayable request or action sequence;
- controlled identity and precondition provenance;
- before/after state or another concrete security-relevant observable;
- a negative control or fixed-version differential when feasible;
- minimized artifacts with secrets and personal data redacted;
- proof that every action stayed inside the declared authorization boundary.

Reuse the existing evidence gate and planned capability-surface artifact.
Dynamic runtime support is a separate concrete feature; the current
`capability_surface` design deliberately proves behavior with local fake inputs
and does not itself constitute live penetration testing.

## The Priority Work

### Priority 0: Close One Official Novel-Vulnerability Loop

This is the most important work and should override broad platform expansion.

Launch the BNB Pasteur campaign immediately after scope revalidation. Freeze the
source versions and answer-free materials, run repeated independent samples,
deep-audit changed regions with their composition boundaries, execute-confirm
every candidate, reproduce against the real release or deployment only through
local nodes or forks, perform novelty and scope checks, submit the strongest
eligible issue, and track it through official disposition and remediation.

The campaign is complete only when every serious candidate is either:

- officially submitted with a durable submission identifier;
- rejected or marked duplicate with the external reason recorded;
- refuted by execution;
- blocked with the exact missing authority or resource recorded; or
- accepted and, ideally, fixed, credited, assigned an advisory, or paid.

An internal `submitted` status is not completion.

### Priority 1: Add General Stateful Execution-Discovery Affordances

Build the smallest general capability that directly increases recall on recent
multi-step failures:

- model-controlled sequence generation and execution;
- deterministic snapshot/reset/replay/minimization;
- model-declared before/after observables and conservation properties;
- local-fork and local-node support through the existing sandbox and command
  policy;
- differential execution against controls or fixes;
- reusable positive, negative, and holdout evaluation manifests.

Do not add a token, AMM, BNB, browser, or named bug-class playbook. The feature
must be useful for a smart contract, an HTTP authorization workflow, and a
stateful protocol implementation without changing its core contract.

### Priority 2: Make External Proof a First-Class Artifact

Finish evidence-package export and record external disposition separately from
internal lifecycle state:

- venue and exact scoped asset/version;
- submission identifier and timestamp;
- official severity and judgment;
- duplicate, rejection, acceptance, remediation, advisory, credit, and payout;
- public-safe disclosure package after embargo or permission.

This prevents internal evidence volume from being mistaken for externally
validated capability.

### Priority 3: Build Authorized Dynamic Target v1

Only after the flagship campaign is running, implement the engagement manifest,
bounded HTTP/session tools, identity isolation, resettable self-hosted target,
and dynamic evidence contract. Validate it on positive and negative local
fixtures, then use it on one self-hostable non-Web3 target with an official
disclosure path.

## Ninety-Day Plan

### Days 1-14: Start the Proof Campaign

- Revalidate and freeze the BNB Pasteur scope, versions, official materials,
  bounty rules, and release timing.
- Split the source into independent module campaigns with a shared build cache.
- Use run groups and repeated samples; preserve a frozen Flounder version and
  configuration for attribution.
- Resolve every existing high-confidence submit candidate into an external
  submission, refutation, duplicate, or documented blocker.
- Build blind held-out BFB, PHX, and STO regressions from pre-disclosure source
  and safe local fixtures.

### Days 15-45: Improve Only What the Campaign Exposes

- Add stateful sequence, snapshot/reset, observation, minimization, and
  differential affordances.
- Finish optional source-control history and change context because it directly
  supports the fresh-surface target thesis.
- Run positive, negative, and hidden-holdout evaluations with repeated samples.
- Enter one high-quality contest and count only official judgments.

### Days 46-90: Prove Transfer Beyond Source-Only Web3

- Implement Authorized Dynamic Target v1 for local, self-hosted, or explicitly
  authorized staging environments.
- Select one self-hostable Web/API target with a credible bounty or CVE path.
- Produce one replayable dynamic evidence package while continuing the flagship
  Web3 campaign.
- Preflight a larger non-Web3 target such as Firefox without making a broad
  product claim before external acceptance.

Suggested allocation during this period:

- 60% flagship high-impact, fresh-surface campaigns;
- 25% campaign-driven general product improvements;
- 15% authorized non-Web3 dynamic pilot.

## Six-Month Proof Standard

The strategy is working when Flounder has:

- at least one previously unknown vulnerability officially accepted or fixed,
  preferably with a bounty, advisory, CVE/GHSA, or public credit;
- three contests with official results and at least two top-decile finishes or
  repeated unique Medium-or-higher findings;
- at least one accepted non-Web3 result before making the general-purpose
  claim;
- a measured held-out recall and false-positive trend across repeated samples;
- zero authorization, live-write, disclosure, or secret-handling violations.

The primary metric is not findings generated. It is externally accepted,
execution-proven, unique vulnerabilities per campaign-month, adjusted for scope,
severity, duplicate rate, and total cost.

## Decisions to Avoid

- Do not pause real campaigns to build a universal pentest platform.
- Do not audit random small projects solely because their code appears easier.
- Do not repeatedly scan unchanged famous code without a fresh-boundary thesis.
- Do not count known-incident rediscovery, internal confirmation, or internal
  submission state as official proof.
- Do not submit low-confidence volume to manufacture activity.
- Do not encode recent exploit mechanisms as framework-owned prompts,
  taxonomies, or target-specific schedules.
- Do not interact actively with production systems or public chains to prove a
  vulnerability.

The shortest path to long-term influence is a narrow, undeniable proof: one
important unknown vulnerability, found blind, proved faithfully, accepted by an
external authority, and followed by a repeatable system that can do it again.
