# Expected Pass: Unbound Settlement Count

Finding: the count that drives settlement is not bound to the proof statement.

The verifier checks `publicInputsHash`, but the settlement loop consumes
`settlementCount` from bytes outside that proof commitment. A caller can keep a
deposit committed to the proof while changing how many records the L1
settlement loop executes, which creates an asset-flow mismatch between deposit
funding and withdrawal payment.
