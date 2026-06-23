# Expected Fail: Halo2 Safe Discharge

No missing constraint is present in this control. The `assign_advice` result is
immediately constrained to the trusted source cell, and the copied advice cell
is the value later consumed by the gate. A report that confirms a bug here would
be over-reporting a safe binding pattern.
