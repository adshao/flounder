# Expected Pass: Halo2 Binding

Finding: assigned advice cells are not bound to the trusted source value.

The region writes prover-controlled values with `assign_advice`, then later
logic treats those cells as if they equal the required source or base value.
There is no equality edge such as `constrain_equal` or a correct `copy_advice`
from the source cell. The absence of that edge is the missing constraint: the
witnessed cell can be changed without changing the trusted source.
