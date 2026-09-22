const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repoRoot = __dirname;
const runtimeDbPath = "server/reservations.db";
const runtimeDbSidecarPattern = "server/reservations.db-*";
const protectedDbArtifacts = [
  runtimeDbPath,
  `${runtimeDbPath}-journal`,
  `${runtimeDbPath}-wal`,
  `${runtimeDbPath}-shm`,
];
const gitignorePath = path.join(repoRoot, ".gitignore");

const gitignore = fs.readFileSync(gitignorePath, "utf8");
const ignoreLines = gitignore
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

assert.ok(
  ignoreLines.includes(runtimeDbPath),
  `${runtimeDbPath} must remain explicitly ignored`,
);
assert.ok(
  ignoreLines.includes(runtimeDbSidecarPattern),
  `${runtimeDbSidecarPattern} must remain explicitly ignored`,
);

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.error) {
    throw result.error;
  }

  return result;
}

for (const artifactPath of protectedDbArtifacts) {
  const trackedCheck = runGit([
    "ls-files",
    "--error-unmatch",
    artifactPath,
  ]);

  assert.strictEqual(
    trackedCheck.status,
    1,
    trackedCheck.status === 0
      ? `${artifactPath} is still tracked by Git`
      : `git ls-files failed unexpectedly for ${artifactPath} (status ${trackedCheck.status}): ${trackedCheck.stderr || trackedCheck.stdout}`,
  );

  const ignoreCheck = runGit([
    "check-ignore",
    "--no-index",
    "--quiet",
    "--",
    artifactPath,
  ]);

  assert.strictEqual(
    ignoreCheck.status,
    0,
    `Git does not currently ignore ${artifactPath}: ${ignoreCheck.stderr || ignoreCheck.stdout}`,
  );
}

console.log(
  `PASS: ${runtimeDbPath} and SQLite sidecars are ignored by Git and are not tracked`,
);