# Audit Target

Audit the provided target as an authorized white-hat researcher.

First enumerate a checklist of concrete audit items. Do not jump straight to bug claims.

For each item identify:

- code location
- relevant spec or design statement
- security property that must hold
- failure mode
- attacker-controlled inputs
- why this location deserves scrutiny

Then audit each item with the appropriate specialized lens. Be skeptical of both positive and negative conclusions. A finding is useful only if it is grounded in specific code, missing checks, missing constraints, or demonstrable data flow.

Verification must stay local-only: unit test, regtest, devnet, or forked node. Never target public testnet or mainnet.
