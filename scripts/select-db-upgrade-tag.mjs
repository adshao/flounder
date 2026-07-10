import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Pick the latest released schema that predates the commit under test. A tag
 * workflow includes the newly-created tag in refs, so blindly taking the first
 * semver tag would compare the release to itself and exercise no migration.
 */
export async function selectDbUpgradeTag({ cwd, requestedTag, exec = execFileAsync }) {
  if (requestedTag) return requestedTag;
  const [{ stdout: tagsOutput }, { stdout: headOutput }] = await Promise.all([
    // --merged HEAD excludes releases from unrelated/future branches. The
    // migration baseline must be a real predecessor of the candidate commit.
    exec("git", ["tag", "--merged", "HEAD", "--list", "v*", "--sort=-v:refname"], { cwd }),
    exec("git", ["rev-parse", "HEAD"], { cwd }),
  ]);
  const head = headOutput.trim();
  const tags = tagsOutput.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const tag of tags) {
    const { stdout } = await exec("git", ["rev-list", "-n", "1", tag], { cwd });
    if (stdout.trim() !== head) return tag;
  }
  throw new Error("No previous release tag is available. Fetch tags or set FLOUNDER_DB_UPGRADE_FROM.");
}
