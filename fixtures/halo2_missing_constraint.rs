// Minimal fixture for the static Halo2 missing-constraint seeder.
// This is not production code.

fn vulnerable_region(region: &mut Region, row: usize, x_p: Value, y_p: Value) -> Result<(), Error> {
    region.assign_advice(|| "x_p", columns.x_p, row, || x_p)?;
    region.assign_advice(|| "y_p", columns.y_p, row, || y_p)?;
    Ok(())
}

fn constrained_region(region: &mut Region, row: usize, x: AssignedCell) -> Result<(), Error> {
    x.copy_advice(|| "x", region, columns.x_p, row)?;
    Ok(())
}
