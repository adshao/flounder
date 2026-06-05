// Minimal halo2 scalar-multiplication fixture for blind audit regression.
// The comments describe intended local structure only; they do not identify a
// target protocol, impact, or expected finding.

fn assign_incomplete_addition_input(
    region: &mut Region,
    row: usize,
    offset: usize,
    x_p: Value,
    y_p: Value,
) -> Result<(), Error> {
    // The loop gate relates the working cells across rows.
    region.assign_advice(|| "x_p", self.double_and_add.x_p, row + offset, || x_p)?;
    region.assign_advice(|| "y_p", self.y_p, row + offset, || y_p)?;
    Ok(())
}

fn assign_bound_input(
    region: &mut Region,
    row: usize,
    base_x: AssignedCell,
) -> Result<(), Error> {
    base_x.copy_advice(|| "base_x", region, self.double_and_add.x_p, row)?;
    Ok(())
}
