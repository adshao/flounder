// Minimized Halo2-style negative control for prompt regression.
// The witnessed advice values are immediately bound to the trusted source cells.
// A correct audit should discharge this region rather than report a missing
// assignment constraint.

fn assign_bound_coordinates(
    region: &mut Region,
    row: usize,
    source_x: AssignedCell,
    source_y: AssignedCell,
    x_value: Value,
    y_value: Value,
) -> Result<(), Error> {
    let x_cell = region.assign_advice(|| "x", columns.x, row, || x_value)?;
    let y_cell = region.assign_advice(|| "y", columns.y, row, || y_value)?;

    region.constrain_equal(x_cell.cell(), source_x.cell())?;
    region.constrain_equal(y_cell.cell(), source_y.cell())?;

    Ok(())
}
