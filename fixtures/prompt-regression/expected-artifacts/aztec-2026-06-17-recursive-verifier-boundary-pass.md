# Expected Pass: Recursive Verifier Boundary

Finding: the recursive accumulator pairing relation and canonical public-input
decoding are not enforced at the verifier boundary.

The public input limbs are silently normalized across field domains: coordinates
that should be canonical base-field values are reduced modulo a scalar field.
The recursive accumulator is then combined into the pairing relation on the
wrong side, so the final check can refer to a different statement than the one
encoded by the public inputs.
