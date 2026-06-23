# Expected Fail: Counterfactual Recursive Verifier PoC

This artifact should not score as a prompt-regression success. The argument uses
an attacker-chosen VK, arbitrary challenges, and an internal harness that is not
the deployed verifier path. It therefore demonstrates a counterfactual pairing
experiment, not an attacker-real recursive accumulator or canonical-decoding
failure in the actual verifier boundary.
