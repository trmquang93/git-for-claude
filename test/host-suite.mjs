/**
 * Comprehensive Host-side test suite for the `@local/dsh-git` bundle.
 *
 * Every expectation is derived independently from the git CLI (never from the
 * implementation's output): fixtures are isolated mkdtemp repositories removed
 * in `finally`, and patches expected to stage are validated with `git apply`
 * plus `git diff --cached` / index-content assertions.
 *
 * Run the whole suite:
 *
 *   node test/host-suite.mjs
 *
 * Exit code is non-zero when a normal test fails (or when a test that used to
 * catch a known product bug starts passing). Set STRICT_BUGS=1 to also fail
 * while any documented known bug is still open.
 *
 * Product bugs found by this suite are listed in test/host-findings.md.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPartialPatch, createApi, parsePorcelainV2 } from "../hooks/engine.ts";
import { createIo } from "./io.mjs";
import {
  applyPatchToIndex,
  binaryMarkers,
  cliDiff,
  cliUntrackedDiff,
  createHarness,
  fileText,
  firstLine,
  git,
  gitTry,
  hunkHeaders,
  indexContent,
  indexPaths,
  makeRepo,
  makeTempDir,
  patchBodyLines,
  patchLines,
  removeTempDir,
  runProcess,
  select,
  selectAdded,
  selectChanges,
  selectRemoved,
  statusV1,
  withPlainDir,
  withRepo,
} from "./host-harness.mjs";

const harness = createHarness();
const { test, knownBug, note } = harness;

/** Captured warnings from the engine. */
const warnings = [];
const api = createApi(createIo(warnings));

/** Await `api.diff` and return the patch text. */
async function diffPatch(request) {
  const result = await api.diff(request);
  return result.patch;
}

/** Git's own full commit message, without the pretty-format terminator. */
function commitMessage(dir, ref = "HEAD") {
  return git(dir, "log", "-1", "--pretty=format:%B", ref).replace(/\n$/u, "");
}

/** Text content from a list of lines, with a trailing newline. */
function textOf(lines) {
  return `${lines.join("\n")}\n`;
}

/** Lines `line 1` … `line N`. */
function numberedLines(count, prefix = "line ") {
  return Array.from({ length: count }, (_, index) => `${prefix}${String(index + 1)}`);
}

/** Create a clone of a bare fixture with deterministic identity. */
function cloneRepo(bare, target) {
  const result = runProcess("git", ["clone", "-q", bare, target]);
  if (result.code !== 0) throw new Error(`git clone failed: ${result.stderr.trim()}`);
  git(target, "config", "user.email", "test@example.com");
  git(target, "config", "user.name", "Test User");
  git(target, "config", "commit.gpgsign", "false");
  // git >= 2.54 refuses a divergent pull unless a reconciliation strategy is set.
  git(target, "config", "pull.rebase", "false");
  return target;
}

/* ================================================================== *
 * 1. parsePorcelainV2 — unit tests against the documented format.
 * ================================================================== */

test("parse/branch-facts-rename-token-and-row-kinds", () => {
  const raw = [
    "# branch.oid 1234567890abcdef1234567890abcdef12345678",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +3 -2",
    "1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb modified file.txt",
    "2 R. N... 100644 100644 100644 cccccccccccccccccccccccccccccccccccccccc dddddddddddddddddddddddddddddddddddddddd R100 new name.txt",
    "old name.txt",
    "1 M. N... 100644 100644 100644 eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee ffffffffffffffffffffffffffffffffffffffff after rename.txt",
    "u UU N... 100644 100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 conflicted.txt",
    "? untracked path.txt",
    "! ignored path.txt",
    "",
  ].join("\0");
  const parsed = parsePorcelainV2(raw);
  assert.deepEqual(parsed.branch, {
    oid: "1234567890abcdef1234567890abcdef12345678",
    head: "main",
    upstream: "origin/main",
    ahead: 3,
    behind: 2,
  });
  assert.deepEqual(parsed.files, [
    { path: "after rename.txt", x: "M", y: ".", kind: "tracked" },
    { path: "conflicted.txt", x: "U", y: "U", kind: "unmerged" },
    { path: "modified file.txt", x: ".", y: "M", kind: "tracked" },
    { path: "new name.txt", origPath: "old name.txt", x: "R", y: ".", kind: "rename" },
    { path: "untracked path.txt", x: "?", y: "?", kind: "untracked" },
  ]);
  // The rename's original-path token must be consumed, not emitted as a row.
  assert.equal(parsed.files.filter((file) => file.kind === "rename").length, 1);
  // Ignored paths are not part of the panel's model.
  assert.equal(parsed.files.some((file) => file.path.startsWith("ignored")), false);
});

test("parse/empty-and-initial-markers", () => {
  assert.deepEqual(parsePorcelainV2(""), {
    branch: { oid: null, head: null, upstream: null, ahead: 0, behind: 0 },
    files: [],
  });
  const initial = parsePorcelainV2(
    ["# branch.oid (initial)", "# branch.head main", "? new.txt", ""].join("\0"),
  );
  assert.equal(initial.branch.oid, "(initial)");
  assert.equal(initial.branch.head, "main");
  assert.deepEqual(initial.files, [{ path: "new.txt", x: "?", y: "?", kind: "untracked" }]);
});

/* ================================================================== *
 * 2. status — real repositories, rows, counts, in-progress markers.
 * ================================================================== */

test("status/clean-repository-facts", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    const status = await api.status({ dir: repo.dir });
    assert.equal(status.isRepo, true);
    assert.equal(status.dir, repo.dir);
    assert.equal(status.root, repo.real);
    assert.deepEqual(status.files, []);
    assert.deepEqual(status.counts, { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 });
    assert.deepEqual(status.inProgress, { merge: false, rebase: false, cherryPick: false, revert: false });
    assert.deepEqual(status.branch, {
      name: "main",
      detached: false,
      initial: false,
      oid: repo.git("rev-parse", "HEAD"),
      shortOid: repo.git("rev-parse", "--short", "HEAD"),
      upstream: null,
      ahead: 0,
      behind: 0,
    });
  });
});

test("status/rows-counts-and-ignored-paths", async () => {
  await withRepo(
    { ".gitignore": "ignored.txt\n", "a.txt": "alpha\nbeta\ngamma\n", "b.txt": "keep\n", "c.txt": "deleted\n", "d.txt": "staged\n" },
    async (repo) => {
      repo.write("a.txt", "alpha\nBETA\ngamma\n");
      repo.remove("c.txt");
      repo.write("d.txt", "staged\nextra\n");
      repo.git("add", "d.txt");
      repo.write("e.txt", "untracked\n");
      repo.write("ignored.txt", "ignored\n");

      const status = await api.status({ dir: repo.dir });
      assert.deepEqual(status.files, [
        { path: "a.txt", x: ".", y: "M", kind: "tracked" },
        { path: "c.txt", x: ".", y: "D", kind: "tracked" },
        { path: "d.txt", x: "M", y: ".", kind: "tracked" },
        { path: "e.txt", x: "?", y: "?", kind: "untracked" },
      ]);
      assert.deepEqual(status.counts, { staged: 1, unstaged: 3, untracked: 1, conflicts: 0 });
      // Independent git status (v1) of the exact same fixture.
      assert.deepEqual(statusV1(repo.dir), [" M a.txt", " D c.txt", "M  d.txt", "?? e.txt"]);
    },
  );
});

test("status/rename-row-with-spaces", async () => {
  await withRepo({ "old name.txt": "rename me\n" }, async (repo) => {
    repo.git("mv", "old name.txt", "new name.txt");
    const status = await api.status({ dir: repo.dir });
    assert.deepEqual(status.files, [
      { path: "new name.txt", origPath: "old name.txt", x: "R", y: ".", kind: "rename" },
    ]);
    assert.equal(status.counts.staged, 1);
    assert.equal(status.counts.unstaged, 0);
    const rawTokens = repo.git("status", "--porcelain=v2", "--branch", "-z").split("\0");
    assert.equal(rawTokens.filter((token) => token.startsWith("2 ")).length, 1);
  });
});

test("status/unicode-and-space-paths-preserved", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.write("sp ace.txt", "space\n");
    repo.write("tệst-文件.txt", "unicode\n");
    const paths = (await api.status({ dir: repo.dir })).files.map((file) => file.path);
    assert.deepEqual(paths, ["sp ace.txt", "tệst-文件.txt"]);
    await api.stage({ dir: repo.dir, paths: ["sp ace.txt", "tệst-文件.txt"] });
    assert.deepEqual(indexPaths(repo.dir), ["sp ace.txt", "tệst-文件.txt"]);
  });
});

test("status/unborn-head", async () => {
  await withRepo({}, async (repo) => {
    const status = await api.status({ dir: repo.dir });
    assert.equal(status.isRepo, true);
    assert.deepEqual(status.branch, {
      name: "main",
      detached: false,
      initial: true,
      oid: null,
      shortOid: null,
      upstream: null,
      ahead: 0,
      behind: 0,
    });
    assert.deepEqual(status.files, []);
    assert.deepEqual(status.counts, { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 });
  }, { initialCommit: false });
});

test("status/detached-head", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.git("commit", "-q", "--allow-empty", "-m", "second");
    repo.git("checkout", "-q", "--detach", "HEAD~1");
    const status = await api.status({ dir: repo.dir });
    assert.equal(status.branch.name, null);
    assert.equal(status.branch.detached, true);
    assert.equal(status.branch.initial, false);
    assert.equal(status.branch.oid, repo.git("rev-parse", "HEAD"));
    assert.equal(status.branch.shortOid, repo.git("rev-parse", "--short", "HEAD"));
  });
});

test("status/ahead-behind-against-upstream", async () => {
  const bare = makeTempDir("git-for-claude-bare-");
  const cloneDir = makeTempDir("git-for-claude-clone-");
  try {
    git(bare, "init", "-q", "--bare");
    await withRepo({ "a.txt": "one\n" }, async (seed) => {
      seed.git("remote", "add", "origin", bare);
      seed.git("push", "-q", "-u", "origin", "main");
      cloneRepo(bare, cloneDir);
      // Clone gets one commit the seed does not have …
      writeFileSync(join(cloneDir, "b.txt"), "bee\n");
      git(cloneDir, "add", "-A");
      git(cloneDir, "commit", "-q", "-m", "clone commit");
      // … and the seed pushes one commit the clone has not fetched yet.
      seed.write("a.txt", "one\ntwo\n");
      seed.git("add", "-A");
      seed.git("commit", "-q", "-m", "seed commit");
      seed.git("push", "-q", "origin", "main");
      git(cloneDir, "fetch", "-q", "origin");

      const status = await api.status({ dir: cloneDir });
      const ahead = Number(git(cloneDir, "rev-list", "--count", "origin/main..HEAD"));
      const behind = Number(git(cloneDir, "rev-list", "--count", "HEAD..origin/main"));
      assert.equal(ahead, 1);
      assert.equal(behind, 1);
      assert.equal(status.branch.upstream, "origin/main");
      assert.equal(status.branch.ahead, ahead);
      assert.equal(status.branch.behind, behind);
    });
  } finally {
    removeTempDir(bare);
    removeTempDir(cloneDir);
  }
});

test("status/merge-conflict-in-progress-and-rows", async () => {
  await withRepo({ "c.txt": "base\n" }, async (repo) => {
    repo.git("checkout", "-q", "-b", "other");
    repo.write("c.txt", "other\n");
    repo.git("commit", "-q", "-a", "-m", "other side");
    repo.git("checkout", "-q", "main");
    repo.write("c.txt", "main side\n");
    repo.git("commit", "-q", "-a", "-m", "main side");

    const merge = await api.merge({ dir: repo.dir, ref: "other" });
    assert.equal(merge.ok, false);
    assert.equal(merge.conflicts, true);

    const status = await api.status({ dir: repo.dir });
    assert.deepEqual(status.inProgress, { merge: true, rebase: false, cherryPick: false, revert: false });
    assert.deepEqual(status.files, [{ path: "c.txt", x: "U", y: "U", kind: "unmerged" }]);
    assert.equal(status.counts.conflicts, 1);
    assert.deepEqual(statusV1(repo.dir), ["UU c.txt"]);
    // Independent marker check.
    assert.equal(repo.tryGit("rev-parse", "-q", "--verify", "MERGE_HEAD").code, 0);
  });
});

test("status/cherry-pick-conflict-in-progress", async () => {
  await withRepo({ "c.txt": "base\n" }, async (repo) => {
    repo.git("checkout", "-q", "-b", "side");
    repo.write("c.txt", "side\n");
    repo.git("commit", "-q", "-a", "-m", "side");
    const side = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "-q", "main");
    repo.write("c.txt", "main\n");
    repo.git("commit", "-q", "-a", "-m", "main");

    const pick = await api.cherryPick({ dir: repo.dir, hash: side });
    assert.equal(pick.ok, false);
    assert.equal(pick.conflicts, true);
    const status = await api.status({ dir: repo.dir });
    assert.equal(status.inProgress.cherryPick, true);
    assert.equal(status.inProgress.merge, false);
    assert.equal(status.files[0].kind, "unmerged");
    assert.equal(repo.tryGit("rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD").code, 0);
  });
});

/* ================================================================== *
 * 3. diff — tracked / staged / untracked / binary / context.
 * ================================================================== */

test("diff/worktree-patch-equals-git-cli", async () => {
  await withRepo({ "f.txt": textOf(numberedLines(12)) }, async (repo) => {
    const lines = numberedLines(12);
    lines[1] = "line 2 CHANGED";
    lines[9] = "line 10 CHANGED";
    repo.write("f.txt", textOf(lines));
    const result = await api.diff({ dir: repo.dir, path: "f.txt" });
    assert.equal(result.staged, false);
    assert.equal(result.untracked, false);
    assert.equal(result.empty, false);
    assert.equal(result.binary, false);
    assert.equal(result.root, repo.real);
    assert.equal(result.path, "f.txt");
    assert.equal(result.patch, cliDiff(repo.dir, "f.txt"));
    assert.equal(hunkHeaders(result.patch).length, 2);
  });
});

test("diff/staged-patch-equals-git-cli", async () => {
  await withRepo({ "f.txt": textOf(numberedLines(8)) }, async (repo) => {
    const lines = numberedLines(8);
    lines[3] = "line 4 CHANGED";
    repo.write("f.txt", textOf(lines));
    repo.git("add", "f.txt");
    const result = await api.diff({ dir: repo.dir, path: "f.txt", staged: true });
    assert.equal(result.staged, true);
    assert.equal(result.patch, cliDiff(repo.dir, "f.txt", { staged: true }));
  });
});

test("diff/context-parameter-is-honoured", async () => {
  await withRepo({ "f.txt": textOf(numberedLines(12)) }, async (repo) => {
    const lines = numberedLines(12);
    lines[5] = "line 6 CHANGED";
    repo.write("f.txt", textOf(lines));
    assert.equal(await diffPatch({ dir: repo.dir, path: "f.txt", context: 1 }), cliDiff(repo.dir, "f.txt", { context: 1 }));
    assert.equal(await diffPatch({ dir: repo.dir, path: "f.txt", context: 5 }), cliDiff(repo.dir, "f.txt", { context: 5 }));
  });
});

test("diff/untracked-file-renders-a-full-addition", async () => {
  await withRepo({ "base.txt": "x\n" }, async (repo) => {
    repo.write("new.txt", "alpha\nbeta\ngamma\n");
    const result = await api.diff({ dir: repo.dir, path: "new.txt", untracked: true });
    assert.equal(result.untracked, true);
    assert.equal(result.staged, false);
    assert.equal(result.empty, false);
    assert.equal(result.binary, false);
    assert.match(result.patch, /^diff --git /mu);
    assert.match(result.patch, /^new file mode 100644$/mu);
    assert.deepEqual(hunkHeaders(result.patch), ["@@ -0,0 +1,3 @@"]);
    assert.deepEqual(
      patchBodyLines(result.patch),
      ["+alpha", "+beta", "+gamma"],
    );
  });
});

test("diff/binary-tracked-staged-and-untracked", async () => {
  await withRepo({ "bin.dat": Buffer.from([0, 1, 2, 3, 255, 254]), "a.txt": "one\n" }, async (repo) => {
    // working-tree modification
    repo.write("bin.dat", Buffer.from([9, 8, 7, 0, 255]));
    const worktree = await api.diff({ dir: repo.dir, path: "bin.dat" });
    assert.equal(worktree.binary, true);
    assert.equal(binaryMarkers(worktree.patch).length, 1);
    // staged modification
    repo.git("add", "bin.dat");
    const staged = await api.diff({ dir: repo.dir, path: "bin.dat", staged: true });
    assert.equal(staged.binary, true);
    assert.equal(binaryMarkers(staged.patch).length, 1);
    // untracked binary
    repo.write("bin-new.dat", Buffer.from([1, 0, 2, 0, 3]));
    const untracked = await api.diff({ dir: repo.dir, path: "bin-new.dat", untracked: true });
    assert.equal(untracked.binary, true);
    assert.equal(untracked.empty, false);
  });
});

test("diff/empty-for-unchanged-and-missing-path", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    const unchanged = await api.diff({ dir: repo.dir, path: "a.txt" });
    assert.equal(unchanged.patch, "");
    assert.equal(unchanged.empty, true);
    const missing = await api.diff({ dir: repo.dir, path: "nope.txt" });
    assert.equal(missing.patch, "");
    assert.equal(missing.empty, true);
  });
});

test("diff/requires-a-path", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    await assert.rejects(api.diff({ dir: repo.dir }), /a path is required/u);
  });
});

// HOST-04: untracked diffs are generated from an absolute path, so the patch
// headers are absolute instead of repository-relative. This silently corrupts
// stageLines (see HOST-05) but the header itself is also wrong for a panel that
// labels the file.
test("diff/untracked-patch-headers-are-repo-relative", async () => {
  await withRepo({ "base.txt": "x\n" }, async (repo) => {
    repo.write("new.txt", "alpha\nbeta\n");
    const result = await api.diff({ dir: repo.dir, path: "new.txt", untracked: true });
    assert.match(
      result.patch,
      /^\+\+\+ b\/new\.txt$/mu,
      `untracked diff must use the repo-relative path in its header; got:\n${firstLine(result.patch.replace(/\n/gu, " | "), 400)}`,
    );
  });
});

// HOST-10: `context: 0` is a valid unified-diff request (-U0). positiveInt()
// treats 0 as "not set" and falls back to 3, so a caller can never ask for a
// zero-context diff.
test("diff/context-zero-is-honoured", async () => {
  await withRepo({ "f.txt": textOf(numberedLines(12)) }, async (repo) => {
    const lines = numberedLines(12);
    lines[5] = "line 6 CHANGED";
    repo.write("f.txt", textOf(lines));
    const actual = await diffPatch({ dir: repo.dir, path: "f.txt", context: 0 });
    const expected = cliDiff(repo.dir, "f.txt", { context: 0 });
    assert.equal(actual, expected, `context:0 must produce the -U0 diff; got header ${firstLine(hunkHeaders(actual)[0], 120)}`);
  });
});

/* ================================================================== *
 * 4. buildPartialPatch — units, validated by really applying patches.
 * ================================================================== */

test("partial/no-selection-and-context-only-return-empty", async () => {
  await withRepo({ "f.txt": textOf(numberedLines(6)) }, async (repo) => {
    const lines = numberedLines(6);
    lines[2] = "line 3 CHANGED";
    repo.write("f.txt", textOf(lines));
    const patch = await diffPatch({ dir: repo.dir, path: "f.txt" });
    assert.equal(buildPartialPatch(patch, []), "");
    assert.equal(buildPartialPatch(patch, new Set()), "");
    assert.equal(buildPartialPatch("", [1, 2]), "");
    const contextOnly = select(patch, (line) => line.startsWith(" "));
    assert.ok(contextOnly.length > 0);
    assert.equal(buildPartialPatch(patch, contextOnly), "");
    // Indexes that do not exist in the patch are ignored, not thrown on.
    assert.equal(buildPartialPatch(patch, [10_000]), "");
  });
});

test("partial/full-selection-stages-the-whole-hunk", async () => {
  await withRepo({ "f.txt": textOf(numberedLines(10)) }, async (repo) => {
    const lines = numberedLines(10);
    lines[1] = "line 2 CHANGED";
    lines[8] = "line 9 CHANGED";
    repo.write("f.txt", textOf(lines));
    const patch = await diffPatch({ dir: repo.dir, path: "f.txt" });
    const selected = selectChanges(patch);
    const partial = buildPartialPatch(patch, new Set(selected));
    const applied = applyPatchToIndex(repo.dir, partial);
    assert.equal(applied.code, 0, `full-hunk partial must apply: ${applied.stderr}`);
    assert.equal(cliDiff(repo.dir, "f.txt", { staged: true }), patch, "staged diff must equal the displayed diff");
    assert.equal(indexContent(repo.dir, "f.txt"), textOf(lines));
  });
});

test("partial/hunk-header-recount-single-insertion", async () => {
  await withRepo({ "f.txt": textOf(numberedLines(10)) }, async (repo) => {
    const lines = numberedLines(10);
    lines.splice(5, 0, "INS-1", "INS-2"); // after line 5
    repo.write("f.txt", textOf(lines));
    const patch = await diffPatch({ dir: repo.dir, path: "f.txt" });
    const originalHeader = hunkHeaders(patch)[0];
    assert.ok(originalHeader, "fixture must produce one hunk");
    const selected = select(patch, (line) => line === "+INS-1");
    assert.equal(selected.length, 1);
    const partial = buildPartialPatch(patch, selected);
    const headers = hunkHeaders(partial);
    assert.equal(headers.length, 1);
    // Independent recount: the hunk starts at old line 3 with 6 old lines and
    // now has 7 new lines (one of the two added lines selected); the function
    // section suffix must be preserved verbatim.
    const expectedHeader = originalHeader.replace(/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/u, "@@ -3,6 +3,7 @@");
    assert.equal(headers[0], expectedHeader);
    const applied = applyPatchToIndex(repo.dir, partial);
    assert.equal(applied.code, 0, `recounted partial must apply: ${applied.stderr}`);
    const expectedLines = numberedLines(10);
    expectedLines.splice(5, 0, "INS-1");
    assert.equal(indexContent(repo.dir, "f.txt"), textOf(expectedLines));
  });
});

test("partial/multi-hunk-select-only-second-hunk", async () => {
  await withRepo({ "f.txt": textOf(numberedLines(30)) }, async (repo) => {
    const lines = numberedLines(30);
    lines[3] = "line 4 CHANGED";
    lines[24] = "line 25 CHANGED";
    repo.write("f.txt", textOf(lines));
    const patch = await diffPatch({ dir: repo.dir, path: "f.txt" });
    const originalHeaders = hunkHeaders(patch);
    assert.equal(originalHeaders.length, 2);
    const selected = select(patch, (line) => line === "-line 25" || line === "+line 25 CHANGED");
    assert.equal(selected.length, 2);
    const partial = buildPartialPatch(patch, selected);
    assert.deepEqual(hunkHeaders(partial), [originalHeaders[1]], "only the fully selected second hunk survives");
    const applied = applyPatchToIndex(repo.dir, partial);
    assert.equal(applied.code, 0, `second-hunk-only partial must apply: ${applied.stderr}`);
    const expected = numberedLines(30);
    expected[24] = "line 25 CHANGED"; // first change stays unstaged
    assert.equal(indexContent(repo.dir, "f.txt"), textOf(expected));
  });
});

test("partial/select-only-deleted-line-of-a-modification", async () => {
  await withRepo({ "f.txt": "ctx1\nOLD\nctx2\n" }, async (repo) => {
    repo.write("f.txt", "ctx1\nNEW\nctx2\n");
    const patch = await diffPatch({ dir: repo.dir, path: "f.txt" });
    const selected = selectRemoved(patch);
    assert.equal(selected.length, 1);
    const partial = buildPartialPatch(patch, selected);
    const applied = applyPatchToIndex(repo.dir, partial);
    assert.equal(applied.code, 0, `deletion-only partial must apply: ${applied.stderr}`);
    assert.equal(indexContent(repo.dir, "f.txt"), "ctx1\nctx2\n", "only the removal is staged");
    const staged = cliDiff(repo.dir, "f.txt", { staged: true });
    assert.match(staged, /^-OLD$/mu);
    assert.doesNotMatch(staged, /^\+NEW$/mu);
  });
});

test("partial/hunk-section-header-is-preserved", async () => {
  await withRepo(
    { "f.txt": textOf(Array.from({ length: 20 }, (_, index) => `func${String(index)}: line ${String(index)}`)) },
    async (repo) => {
      const lines = Array.from({ length: 20 }, (_, index) => `func${String(index)}: line ${String(index)}`);
      lines[8] = "func8: CHANGED";
      repo.write("f.txt", textOf(lines));
      const patch = await diffPatch({ dir: repo.dir, path: "f.txt" });
      const originalHeader = hunkHeaders(patch)[0];
      assert.match(originalHeader, /^@@ .+ @@ .+$/u, "fixture must produce a function-section header");
      const partial = buildPartialPatch(patch, selectChanges(patch));
      assert.equal(hunkHeaders(partial)[0], originalHeader);
      assert.equal(applyPatchToIndex(repo.dir, partial).code, 0);
      assert.equal(indexContent(repo.dir, "f.txt"), textOf(lines));
    },
  );
});

test("partial/add-only-file-subset", async () => {
  await withRepo({ "base.txt": "x\n" }, async (repo) => {
    repo.write("new.txt", "alpha\nbeta\ngamma\n");
    // Relative path keeps the patch headers repo-relative, which is the shape a
    // correct untracked diff should have (see HOST-04).
    const patch = cliUntrackedDiff(repo.dir, "new.txt");
    const selected = select(patch, (line) => line === "+alpha" || line === "+gamma");
    assert.equal(selected.length, 2);
    const partial = buildPartialPatch(patch, selected);
    assert.deepEqual(hunkHeaders(partial), ["@@ -0,0 +1,2 @@"]);
    const applied = applyPatchToIndex(repo.dir, partial);
    assert.equal(applied.code, 0, `new-file subset must apply: ${applied.stderr}`);
    assert.deepEqual(indexPaths(repo.dir), ["new.txt"]);
    assert.equal(indexContent(repo.dir, "new.txt"), "alpha\ngamma\n");
    // The worktree file is untouched.
    assert.equal(fileText(repo.dir, "new.txt"), "alpha\nbeta\ngamma\n");
  });
});

test("partial/no-newline-marker-follows-selected-deletion", async () => {
  await withRepo({ "f.txt": "one\ntwo" }, async (repo) => {
    repo.write("f.txt", "one\n");
    const patch = await diffPatch({ dir: repo.dir, path: "f.txt" });
    assert.deepEqual(hunkHeaders(patch), ["@@ -1,2 +1 @@"]);
    const selected = select(patch, (line) => line === "-two");
    const partial = buildPartialPatch(patch, selected);
    assert.match(partial, /^\\ No newline at end of file$/mu);
    const applied = applyPatchToIndex(repo.dir, partial);
    assert.equal(applied.code, 0, `no-newline deletion partial must apply: ${applied.stderr}`);
    assert.equal(indexContent(repo.dir, "f.txt"), "one\n");
  });
});

test("partial/no-newline-full-selection-keeps-both-markers", async () => {
  await withRepo({ "f.txt": "one\ntwo" }, async (repo) => {
    repo.write("f.txt", "one\nTWO");
    const patch = await diffPatch({ dir: repo.dir, path: "f.txt" });
    assert.match(patch, /^\\ No newline at end of file$/mu);
    const partial = buildPartialPatch(patch, selectChanges(patch));
    const markers = patchBodyLines(partial).filter((line) => line.startsWith("\\"));
    assert.equal(markers.length, 2, "both EOF markers belong to the fully selected change");
    const applied = applyPatchToIndex(repo.dir, partial);
    assert.equal(applied.code, 0, `full no-newline patch must apply: ${applied.stderr}`);
    assert.equal(indexContent(repo.dir, "f.txt"), "one\nTWO");
  });
});

// HOST-01: a `-`/`+` replacement pair is two selectable body lines. Selecting
// only the `+` line must keep the unselected `-` line as context (the line is
// still in the index), otherwise the resulting patch cannot apply. The
// reference patch below proves the expected staged state is achievable.
test("partial/only-added-line-keeps-unselected-deletion-as-context", async () => {
  await withRepo({ "f.txt": "ctx1\nOLD\nctx2\n" }, async (repo) => {
    repo.write("f.txt", "ctx1\nNEW\nctx2\n");
    const patch = await diffPatch({ dir: repo.dir, path: "f.txt" });
    const selected = select(patch, (line) => line === "+NEW");
    assert.equal(selected.length, 1);
    const partial = buildPartialPatch(patch, selected);
    const implApply = applyPatchToIndex(repo.dir, partial);
    const implContent = indexContent(repo.dir, "f.txt");

    // Independent feasibility proof: the same selection built by hand.
    repo.git("reset", "-q");
    const reference = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,4 @@",
      " ctx1",
      " OLD",
      "+NEW",
      " ctx2",
      "",
    ].join("\n");
    const referenceApply = applyPatchToIndex(repo.dir, reference);
    assert.equal(referenceApply.code, 0, `reference partial must apply: ${referenceApply.stderr}`);
    assert.equal(indexContent(repo.dir, "f.txt"), "ctx1\nOLD\nNEW\nctx2\n");

    assert.equal(
      implApply.code,
      0,
      `selecting only the added line must produce an applicable patch; git apply says: ${implApply.stderr.trim() || "(no stderr)"}\n${partial}`,
    );
    assert.equal(implContent, "ctx1\nOLD\nNEW\nctx2\n");
  });
});

// HOST-03: partial staging of a whole-file deletion. The diff header says
// "deleted file mode / +++ /dev/null", so a subset of deleted lines requires a
// modification-style header plus unselected deletions kept as context.
test("partial/pure-file-deletion-line-subset", async () => {
  await withRepo({ "del.txt": "d1\nd2\nd3\nd4\n" }, async (repo) => {
    repo.remove("del.txt");
    const patch = await diffPatch({ dir: repo.dir, path: "del.txt" });
    assert.match(patch, /^deleted file mode 100644$/mu);
    const selected = select(patch, (line) => line === "-d2");
    assert.equal(selected.length, 1);
    const partial = buildPartialPatch(patch, selected);
    const implApply = applyPatchToIndex(repo.dir, partial);
    const implContent = indexContent(repo.dir, "del.txt");
    repo.git("reset", "-q");

    // Independent feasibility proof: stage only the removal of d2.
    const reference = [
      "diff --git a/del.txt b/del.txt",
      "--- a/del.txt",
      "+++ b/del.txt",
      "@@ -1,4 +1,3 @@",
      " d1",
      "-d2",
      " d3",
      " d4",
      "",
    ].join("\n");
    const referenceApply = applyPatchToIndex(repo.dir, reference);
    assert.equal(referenceApply.code, 0, `reference partial must apply: ${referenceApply.stderr}`);
    assert.equal(indexContent(repo.dir, "del.txt"), "d1\nd3\nd4\n");

    assert.equal(
      implApply.code,
      0,
      `staging one deleted line of a deleted file must apply; git apply says: ${implApply.stderr.trim() || "(no stderr)"}\n${partial}`,
    );
    assert.equal(implContent, "d1\nd3\nd4\n");
  });
});

// HOST-06: the "\ No newline at end of file" marker belongs to the body line
// directly before it. When that line is dropped, the marker must be dropped
// too; buildPartialPatch keeps it whenever anything earlier was selected, which
// can produce a patch that claims a newline-less context line and cannot apply.
test("partial/no-newline-marker-not-kept-for-dropped-line", async () => {
  await withRepo({ "f.txt": "one\ntwo" }, async (repo) => {
    repo.write("f.txt", "one\nTWO");
    const patch = await diffPatch({ dir: repo.dir, path: "f.txt" });
    const selected = select(patch, (line) => line === "+TWO");
    assert.equal(selected.length, 1);
    const partial = buildPartialPatch(patch, selected);
    const applied = partial === "" ? { code: 0, stderr: "" } : applyPatchToIndex(repo.dir, partial);
    assert.ok(
      partial === "" || applied.code === 0,
      `an EOF-change partial must either be empty or apply; git says: ${applied.stderr.trim() || "(no stderr)"}\n${partial}`,
    );
  });
});

/* ================================================================== *
 * 5. stageLines — end-to-end partial staging, verified via git diff.
 * ================================================================== */

test("stageLines/stage-one-of-two-hunks-then-the-other", async () => {
  await withRepo({ "f.txt": textOf(numberedLines(30)) }, async (repo) => {
    const lines = numberedLines(30);
    lines[3] = "line 4 CHANGED";
    lines[24] = "line 25 CHANGED";
    repo.write("f.txt", textOf(lines));
    const fullPatch = await diffPatch({ dir: repo.dir, path: "f.txt" });
    assert.equal(hunkHeaders(fullPatch).length, 2);

    const first = select(fullPatch, (line) => line === "-line 4" || line === "+line 4 CHANGED");
    await api.stageLines({ dir: repo.dir, path: "f.txt", staged: false, patch: fullPatch, lines: first });
    const afterFirst = numberedLines(30);
    afterFirst[3] = "line 4 CHANGED";
    assert.equal(indexContent(repo.dir, "f.txt"), textOf(afterFirst), "only the first hunk is staged");
    assert.equal(fileText(repo.dir, "f.txt"), textOf(lines), "worktree is untouched");

    const remaining = await diffPatch({ dir: repo.dir, path: "f.txt" });
    assert.equal(hunkHeaders(remaining).length, 1, "only the second change remains unstaged");
    assert.match(remaining, /line 25 CHANGED/u);
    assert.doesNotMatch(remaining, /line 4 CHANGED/u);
    const second = selectChanges(remaining);
    await api.stageLines({ dir: repo.dir, path: "f.txt", staged: false, patch: remaining, lines: second });
    assert.equal(indexContent(repo.dir, "f.txt"), textOf(lines));
    assert.equal(cliDiff(repo.dir, "f.txt", { staged: true }), fullPatch, "both hunks staged");
  });
});

test("stageLines/stage-selected-additions-from-two-hunks", async () => {
  await withRepo({ "f.txt": textOf(numberedLines(30)) }, async (repo) => {
    const lines = numberedLines(30);
    lines.splice(10, 0, "INS-A");
    lines.splice(26, 0, "INS-B");
    repo.write("f.txt", textOf(lines));
    const patch = await diffPatch({ dir: repo.dir, path: "f.txt" });
    assert.equal(hunkHeaders(patch).length, 2);
    const selected = select(patch, (line) => line === "+INS-A" || line === "+INS-B");
    assert.equal(selected.length, 2);
    await api.stageLines({ dir: repo.dir, path: "f.txt", staged: false, patch, lines: selected });
    assert.equal(indexContent(repo.dir, "f.txt"), textOf(lines));
    assert.equal(fileText(repo.dir, "f.txt"), textOf(lines));
  });
});

test("stageLines/reverse-unstage-one-of-two-hunks", async () => {
  await withRepo({ "f.txt": textOf(numberedLines(30)) }, async (repo) => {
    const lines = numberedLines(30);
    lines[3] = "line 4 CHANGED";
    lines[24] = "line 25 CHANGED";
    repo.write("f.txt", textOf(lines));
    repo.git("add", "f.txt");
    const stagedPatch = await diffPatch({ dir: repo.dir, path: "f.txt", staged: true });
    assert.equal(hunkHeaders(stagedPatch).length, 2);

    const first = select(stagedPatch, (line) => line === "-line 4" || line === "+line 4 CHANGED");
    await api.stageLines({ dir: repo.dir, path: "f.txt", staged: true, patch: stagedPatch, lines: first });
    const expectedIndex = numberedLines(30);
    expectedIndex[24] = "line 25 CHANGED"; // first change moved back to unstaged
    assert.equal(indexContent(repo.dir, "f.txt"), textOf(expectedIndex));
    assert.equal(fileText(repo.dir, "f.txt"), textOf(lines), "worktree unchanged by unstage");

    const cached = cliDiff(repo.dir, "f.txt", { staged: true });
    assert.equal(hunkHeaders(cached).length, 1);
    assert.match(cached, /line 25 CHANGED/u);
    assert.doesNotMatch(cached, /line 4 CHANGED/u);
    const unstaged = await diffPatch({ dir: repo.dir, path: "f.txt" });
    assert.equal(hunkHeaders(unstaged).length, 1);
    assert.match(unstaged, /line 4 CHANGED/u);
  });
});

// HOST-12: unstaging a single added line that sits inside a contiguous block of
// new lines (the other added lines stay staged). This is the reverse-direction
// twin of HOST-02: unselected `+` lines are dropped instead of being kept as
// context, so the reversed patch's target side no longer matches the index.
test("stageLines/reverse-unstage-one-added-line-of-a-block", async () => {
  await withRepo({ "f.txt": textOf(numberedLines(10)) }, async (repo) => {
    const lines = numberedLines(10);
    lines.splice(3, 0, "a1", "a2", "a3"); // after line 3
    repo.write("f.txt", textOf(lines));
    repo.git("add", "f.txt");
    const stagedPatch = await diffPatch({ dir: repo.dir, path: "f.txt", staged: true });
    assert.equal(hunkHeaders(stagedPatch).length, 1);
    const selected = select(stagedPatch, (line) => line === "+a2");
    assert.equal(selected.length, 1);
    const partial = buildPartialPatch(stagedPatch, selected, true);
    const implApply = applyPatchToIndex(repo.dir, partial, { reverse: true });
    const implContent = indexContent(repo.dir, "f.txt");

    // Independent feasibility proof: a1/a3 stay in the index, a2 is removed.
    repo.git("reset", "-q");
    repo.git("add", "f.txt");
    const reference = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,8 +1,9 @@",
      " line 1",
      " line 2",
      " line 3",
      " a1",
      "+a2",
      " a3",
      " line 4",
      " line 5",
      " line 6",
      "",
    ].join("\n");
    const referenceApply = applyPatchToIndex(repo.dir, reference, { reverse: true });
    assert.equal(referenceApply.code, 0, `reference reverse partial must apply: ${referenceApply.stderr}`);
    const expectedIndex = numberedLines(10);
    expectedIndex.splice(3, 0, "a1", "a3");
    assert.equal(indexContent(repo.dir, "f.txt"), textOf(expectedIndex));

    assert.equal(
      implApply.code,
      0,
      `unstaging one added line of a block must apply; git apply says: ${implApply.stderr.trim() || "(no stderr)"}\n${partial}`,
    );
    assert.equal(implContent, textOf(expectedIndex));
  });
});

test("stageLines/add-only-file-from-relative-patch", async () => {
  await withRepo({ "base.txt": "x\n" }, async (repo) => {
    repo.write("new.txt", "alpha\nbeta\ngamma\n");
    const patch = cliUntrackedDiff(repo.dir, "new.txt");
    const selected = select(patch, (line) => line === "+alpha" || line === "+gamma");
    await api.stageLines({ dir: repo.dir, path: "new.txt", staged: false, patch, lines: selected });
    assert.deepEqual(indexPaths(repo.dir), ["new.txt"]);
    assert.equal(indexContent(repo.dir, "new.txt"), "alpha\ngamma\n");
    assert.equal(fileText(repo.dir, "new.txt"), "alpha\nbeta\ngamma\n");
  });
});

test("stageLines/whole-file-deletion-then-unstage-all", async () => {
  await withRepo({ "del.txt": "d1\nd2\n", "keep.txt": "k\n" }, async (repo) => {
    repo.remove("del.txt");
    const patch = await diffPatch({ dir: repo.dir, path: "del.txt" });
    await api.stageLines({ dir: repo.dir, path: "del.txt", staged: false, patch, lines: selectRemoved(patch) });
    assert.equal(repo.git("diff", "--cached", "--name-status"), "D\tdel.txt");
    assert.equal(indexContent(repo.dir, "del.txt"), null);
    await api.unstage({ dir: repo.dir, paths: [] });
    assert.deepEqual(statusV1(repo.dir), [" D del.txt"], "deletion is unstaged again, worktree file still gone");
  });
});

test("stageLines/validation-errors", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    await assert.rejects(api.stageLines({ dir: repo.dir, patch: "" }), /the displayed diff is required/u);
    const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n";
    await assert.rejects(api.stageLines({ dir: repo.dir, patch, lines: [] }), /no lines were selected/u);
    // A non-empty selection against a patch that does not match the index.
    const stale = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-MISSING-CONTENT\n+other\n";
    await assert.rejects(
      api.stageLines({ dir: repo.dir, patch: stale, lines: selectChanges(stale) }),
      /patch does not apply|patch failed/u,
    );
  });
});

// HOST-05: api.diff(untracked:true) hands the browser a patch with absolute
// paths (HOST-04); feeding that patch back to stageLines writes a bogus
// `private/var/...` entry into the index and never stages the real path.
test("stageLines/untracked-file-stages-the-repo-relative-path", async () => {
  await withRepo({ "base.txt": "x\n" }, async (repo) => {
    repo.write("new.txt", "alpha\nbeta\ngamma\n");
    const patch = await diffPatch({ dir: repo.dir, path: "new.txt", untracked: true });
    const selected = select(patch, (line) => line === "+alpha" || line === "+gamma");
    assert.equal(selected.length, 2);
    await api.stageLines({ dir: repo.dir, path: "new.txt", staged: false, patch, lines: selected });
    const stagedPaths = indexPaths(repo.dir);
    assert.deepEqual(stagedPaths, ["new.txt"], `stageLines must stage the repo-relative path; index contains ${JSON.stringify(stagedPaths)}`);
    assert.equal(indexContent(repo.dir, "new.txt"), "alpha\ngamma\n");
  });
});

// HOST-02: reverse partial unstage of a deletion. Unselected `+` lines must be
// kept as context for the reverse apply; dropping them makes the target side of
// the reversed patch not match the index.
test("stageLines/reverse-unstage-only-a-deleted-line", async () => {
  await withRepo({ "f.txt": "ctx1\nOLD\nctx2\n" }, async (repo) => {
    repo.write("f.txt", "ctx1\nNEW\nctx2\n");
    repo.git("add", "f.txt");
    const patch = await diffPatch({ dir: repo.dir, path: "f.txt", staged: true });
    const selected = select(patch, (line) => line === "-OLD");
    assert.equal(selected.length, 1);
    const partial = buildPartialPatch(patch, selected, true);
    const implApply = applyPatchToIndex(repo.dir, partial, { reverse: true });
    const implContent = indexContent(repo.dir, "f.txt");

    // Independent feasibility proof: restore OLD while NEW stays staged.
    repo.git("reset", "-q");
    repo.git("add", "f.txt");
    const reference = [
      "diff --git a/f.txt b/f.txt",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,4 +1,3 @@",
      " ctx1",
      "-OLD",
      " NEW",
      " ctx2",
      "",
    ].join("\n");
    const referenceApply = applyPatchToIndex(repo.dir, reference, { reverse: true });
    assert.equal(referenceApply.code, 0, `reference reverse partial must apply: ${referenceApply.stderr}`);
    assert.equal(indexContent(repo.dir, "f.txt"), "ctx1\nOLD\nNEW\nctx2\n");

    assert.equal(
      implApply.code,
      0,
      `unstaging only the deleted line must apply; git apply says: ${implApply.stderr.trim() || "(no stderr)"}\n${partial}`,
    );
    assert.equal(implContent, "ctx1\nOLD\nNEW\nctx2\n");
  });
});

// HOST-07: unstaging one added line of a staged brand-new file. The selected
// addition is not the first body line, so the recomputed hunk needs an adjusted
// new-side start and modification-style file headers; today the patch neither
// applies nor preserves the file.
test("stageLines/reverse-unstage-middle-line-of-staged-new-file", async () => {
  await withRepo({ "base.txt": "x\n" }, async (repo) => {
    repo.write("new.txt", "alpha\nbeta\ngamma\n");
    repo.git("add", "new.txt");
    const patch = await diffPatch({ dir: repo.dir, path: "new.txt", staged: true });
    const selected = select(patch, (line) => line === "+beta");
    assert.equal(selected.length, 1);
    const partial = buildPartialPatch(patch, selected, true);
    const implApply = applyPatchToIndex(repo.dir, partial, { reverse: true });
    const implContent = indexContent(repo.dir, "new.txt");

    repo.git("reset", "-q");
    repo.git("add", "new.txt");
    const reference = [
      "diff --git a/new.txt b/new.txt",
      "--- a/new.txt",
      "+++ b/new.txt",
      "@@ -1,2 +1,3 @@",
      " alpha",
      "+beta",
      " gamma",
      "",
    ].join("\n");
    const referenceApply = applyPatchToIndex(repo.dir, reference, { reverse: true });
    assert.equal(referenceApply.code, 0, `reference reverse partial must apply: ${referenceApply.stderr}`);
    assert.equal(indexContent(repo.dir, "new.txt"), "alpha\ngamma\n");

    assert.equal(
      implApply.code,
      0,
      `unstaging one added line of a new file must apply; git apply says: ${implApply.stderr.trim() || "(no stderr)"}\n${partial}`,
    );
    assert.equal(implContent, "alpha\ngamma\n");
  });
});

/* ================================================================== *
 * 6. stage / unstage / discard.
 * ================================================================== */

test("stage/unstage-specific-paths-and-all-paths", async () => {
  await withRepo({ "a.txt": "one\n", "b.txt": "bee\n" }, async (repo) => {
    repo.write("a.txt", "one\ntwo\n");
    repo.write("b.txt", "bee\nmore\n");
    await api.stage({ dir: repo.dir, paths: ["a.txt"] });
    assert.deepEqual(statusV1(repo.dir), ["M  a.txt", " M b.txt"]);
    await api.stage({ dir: repo.dir, paths: [] });
    assert.deepEqual(statusV1(repo.dir), ["M  a.txt", "M  b.txt"]);
    await api.unstage({ dir: repo.dir, paths: ["b.txt"] });
    assert.deepEqual(statusV1(repo.dir), ["M  a.txt", " M b.txt"]);
    await api.unstage({ dir: repo.dir, paths: [] });
    assert.deepEqual(statusV1(repo.dir), [" M a.txt", " M b.txt"]);
  });
});

test("unstage/unborn-head-all-and-specific", async () => {
  await withRepo({}, async (repo) => {
    repo.write("f.txt", "x\n");
    repo.git("add", "-A");
    assert.equal((await api.status({ dir: repo.dir })).counts.staged, 1);
    await api.unstage({ dir: repo.dir, paths: [] });
    assert.deepEqual(statusV1(repo.dir), ["?? f.txt"]);
    repo.git("add", "-A");
    warnings.length = 0;
    await api.unstage({ dir: repo.dir, paths: ["f.txt"] });
    assert.deepEqual(statusV1(repo.dir), ["?? f.txt"]);
    assert.ok(
      warnings.some((message) => /restore --staged failed/u.test(message)),
      "path unstage on an unborn HEAD must report the documented rm --cached fallback",
    );
  }, { initialCommit: false });
});

test("discard/tracked-staged-new-untracked-and-keepStaged", async () => {
  await withRepo({ "a.txt": "one\n", "tracked.txt": "tracked\n" }, async (repo) => {
    // worktree modification of a tracked file
    repo.write("tracked.txt", "dirty\n");
    await api.discard({ dir: repo.dir, paths: ["tracked.txt"] });
    assert.equal(repo.read("tracked.txt"), "tracked\n");
    assert.deepEqual(statusV1(repo.dir), []);

    // a new file that was already staged
    repo.write("new.txt", "new file\n");
    repo.git("add", "new.txt");
    await api.discard({ dir: repo.dir, paths: ["new.txt"] });
    assert.equal(repo.exists("new.txt"), false, "staged-new discard removes the file from disk");
    assert.deepEqual(statusV1(repo.dir), []);
    assert.deepEqual(indexPaths(repo.dir), []);

    // keepStaged: index keeps the staged content, worktree returns to it
    repo.write("a.txt", "staged\n");
    repo.git("add", "a.txt");
    repo.write("a.txt", "worktree\n");
    await api.discard({ dir: repo.dir, paths: ["a.txt"], keepStaged: true });
    assert.equal(repo.read("a.txt"), "staged\n");
    assert.equal(indexContent(repo.dir, "a.txt"), "staged\n");
    assert.equal(statusV1(repo.dir)[0], "M  a.txt");

    // untracked file and directory
    repo.write("loose.txt", "loose\n");
    repo.write("loose-dir/deep.txt", "deep\n");
    await api.discard({ dir: repo.dir, paths: ["loose.txt", "loose-dir"], untracked: true });
    assert.equal(repo.exists("loose.txt"), false);
    assert.equal(repo.exists("loose-dir"), false);
  });
});

/* ================================================================== *
 * 7. commit / amend / lastCommitMessage.
 * ================================================================== */

test("commit/basic-message-and-result", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.write("a.txt", "one\ntwo\n");
    repo.git("add", "-A");
    const result = await api.commit({ dir: repo.dir, message: "second commit" });
    assert.equal(result.ok, true);
    assert.equal(result.subject, "second commit");
    assert.equal(result.hash, repo.git("log", "-1", "--pretty=format:%h"));
    assert.equal(repo.git("log", "-1", "--pretty=format:%s"), "second commit");
    assert.equal(repo.git("log", "-1", "--pretty=format:%B").replace(/\n$/u, ""), "second commit");
    assert.deepEqual(statusV1(repo.dir), []);
    assert.equal(result.output.includes("second commit"), true);
  });
});

test("commit/multiline-message-and-lastCommitMessage", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    const message = "subject line\n\nbody paragraph one\nbody paragraph two";
    repo.write("a.txt", "one\ntwo\n");
    repo.git("add", "-A");
    const result = await api.commit({ dir: repo.dir, message });
    assert.equal(result.subject, "subject line");
    assert.equal(commitMessage(repo.dir), message);
    const last = await api.lastCommitMessage({ dir: repo.dir });
    assert.equal(last.message, message);
  });
});

test("commit/amend-reuses-message-and-accepts-new-message", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.write("a.txt", "one\ntwo\n");
    repo.git("add", "-A");
    const first = await api.commit({ dir: repo.dir, message: "original subject" });
    const countBefore = repo.git("rev-list", "--count", "HEAD");

    // Empty-message amend reuses the previous message and does not add a commit.
    const amended = await api.commit({ dir: repo.dir, amend: true });
    assert.equal(amended.ok, true);
    assert.equal(amended.subject, "original subject");
    assert.equal(repo.git("rev-list", "--count", "HEAD"), countBefore);
    assert.equal(repo.git("log", "-1", "--pretty=format:%s"), "original subject");

    // Amending with a new message rewrites HEAD (same count, new subject).
    const renamed = await api.commit({ dir: repo.dir, amend: true, message: "amended subject" });
    assert.equal(renamed.ok, true);
    assert.equal(renamed.subject, "amended subject");
    assert.notEqual(renamed.hash, first.hash);
    assert.equal(repo.git("log", "-1", "--pretty=format:%s"), "amended subject");
    assert.equal(repo.git("rev-list", "--count", "HEAD"), countBefore);
  });
});

test("commit/validation-and-allowEmpty", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    await assert.rejects(api.commit({ dir: repo.dir, message: "" }), /a commit message is required/u);
    await assert.rejects(api.commit({ dir: repo.dir, message: "nothing staged" }), /nothing to commit|no changes added/i);
    const countBefore = repo.git("rev-list", "--count", "HEAD");
    const empty = await api.commit({ dir: repo.dir, message: "empty commit", allowEmpty: true });
    assert.equal(empty.ok, true);
    assert.equal(Number(repo.git("rev-list", "--count", "HEAD")), Number(countBefore) + 1);
  });
});

test("commit/signoff-and-noVerify", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.write("b.txt", "bee\n");
    repo.git("add", "-A");
    const signed = await api.commit({ dir: repo.dir, message: "signed commit", signoff: true });
    assert.equal(signed.ok, true);
    assert.match(commitMessage(repo.dir), /^Signed-off-by: Test User <test@example.com>$/mu);

    const hook = repo.path(".git/hooks/pre-commit");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    repo.write("c.txt", "cee\n");
    repo.git("add", "-A");
    // Hooks are off under $.process.run, so a failing pre-commit hook never blocks.
    const unblocked = await api.commit({ dir: repo.dir, message: "blocked" });
    assert.equal(unblocked.ok, true);
    repo.write("d.txt", "dee\n");
    repo.git("add", "-A");
    const bypassed = await api.commit({ dir: repo.dir, message: "bypass", noVerify: true });
    assert.equal(bypassed.ok, true);
    assert.equal(repo.git("log", "-1", "--pretty=format:%s"), "bypass");
  });
});

test("commit/first-commit-on-unborn-head", async () => {
  await withRepo({}, async (repo) => {
    repo.write("first.txt", "hello\n");
    repo.git("add", "-A");
    const result = await api.commit({ dir: repo.dir, message: "initial commit" });
    assert.equal(result.ok, true);
    assert.equal(result.hash, repo.git("rev-parse", "--short", "HEAD"));
    assert.equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "main");
  }, { initialCommit: false });
});

/* ================================================================== *
 * 8. branches / createBranch / deleteBranch / renameBranch.
 * ================================================================== */

test("branches/local-remote-current-upstream-and-symref-filter", async () => {
  const bare = makeTempDir("git-for-claude-bare-");
  const cloneDir = makeTempDir("git-for-claude-clone-");
  try {
    git(bare, "init", "-q", "--bare");
    await withRepo({ "a.txt": "one\n" }, async (seed) => {
      seed.git("remote", "add", "origin", bare);
      seed.git("push", "-q", "-u", "origin", "main");
      cloneRepo(bare, cloneDir);
      git(cloneDir, "checkout", "-q", "-b", "feature/x");
      writeFileSync(join(cloneDir, "b.txt"), "bee\n");
      git(cloneDir, "add", "-A");
      git(cloneDir, "commit", "-q", "-m", "feature work");
      git(cloneDir, "push", "-q", "-u", "origin", "feature/x");
      git(cloneDir, "checkout", "-q", "main");

      const branches = await api.branches({ dir: cloneDir });
      assert.deepEqual(
        branches.local.map((branch) => branch.name).sort(),
        ["feature/x", "main"],
      );
      const main = branches.local.find((branch) => branch.name === "main");
      assert.equal(main.current, true);
      assert.equal(main.tip, git(cloneDir, "rev-parse", "--short", "main"));
      assert.equal(main.upstream, "origin/main");
      assert.equal(main.subject, "initial");
      assert.equal(main.date.length > 0, true);
      const feature = branches.local.find((branch) => branch.name === "feature/x");
      assert.equal(feature.current, false);
      assert.equal(feature.upstream, "origin/feature/x");
      assert.equal(feature.subject, "feature work");

      // `origin/HEAD` is a symbolic ref and must not be reported as a branch.
      assert.equal(git(cloneDir, "for-each-ref", "--format=%(refname)", "refs/remotes").includes("refs/remotes/origin/HEAD"), true);
      assert.deepEqual(
        branches.remote.map((branch) => branch.name).sort(),
        ["origin/feature/x", "origin/main"],
      );
      const originMain = branches.remote.find((branch) => branch.name === "origin/main");
      assert.equal(originMain.remote, "origin");
      assert.equal(originMain.branch, "main");
      assert.equal(originMain.tip, git(cloneDir, "rev-parse", "--short", "origin/main"));
    });
  } finally {
    removeTempDir(bare);
    removeTempDir(cloneDir);
  }
});

test("branches/create-rename-delete", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.git("commit", "-q", "--allow-empty", "-m", "second");
    const created = await api.createBranch({ dir: repo.dir, name: "feature/new", start: "HEAD~1" });
    assert.equal(created.branch, "feature/new");
    assert.equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "feature/new");
    assert.equal(repo.git("rev-parse", "HEAD"), repo.git("rev-parse", "main~1"));
    // Add a commit so the branch is genuinely unmerged.
    repo.write("feature.txt", "feature\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "feature work");

    await api.renameBranch({ dir: repo.dir, from: "feature/new", to: "feature/renamed" });
    assert.equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "feature/renamed");
    assert.equal(repo.tryGit("show-ref", "--verify", "--quiet", "refs/heads/feature/new").code, 1);

    // Deleting an unmerged branch without force is refused with git's message.
    repo.git("checkout", "-q", "main");
    await assert.rejects(api.deleteBranch({ dir: repo.dir, name: "feature/renamed" }), /not fully merged/u);
    await api.deleteBranch({ dir: repo.dir, name: "feature/renamed", force: true });
    assert.equal(repo.tryGit("show-ref", "--verify", "--quiet", "refs/heads/feature/renamed").code, 1);

    await assert.rejects(api.createBranch({ dir: repo.dir, name: "" }), /a branch name is required/u);
    await assert.rejects(api.deleteBranch({ dir: repo.dir, name: "" }), /a branch name is required/u);
    await assert.rejects(api.renameBranch({ dir: repo.dir, from: "", to: "x" }), /both branch names are required/u);
  });
});

/* ================================================================== *
 * 9. checkout.
 * ================================================================== */

test("checkout/local-branch-tag-and-commit", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.git("commit", "-q", "--allow-empty", "-m", "second");
    repo.git("branch", "other");
    const local = await api.checkout({ dir: repo.dir, ref: "other" });
    assert.deepEqual(local, { ok: true, detached: false, branch: "other" });
    assert.equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "other");

    repo.git("tag", "v1");
    const tag = await api.checkout({ dir: repo.dir, ref: "v1" });
    assert.equal(tag.detached, true);
    assert.equal(tag.branch, null);
    assert.equal(repo.git("rev-parse", "HEAD"), repo.git("rev-parse", "v1^{commit}"));
    assert.equal(repo.git("rev-parse", "--abbrev-ref", "HEAD"), "HEAD");

    const hash = repo.git("rev-parse", "main");
    const commit = await api.checkout({ dir: repo.dir, ref: hash });
    assert.equal(commit.detached, true);
    assert.equal(repo.git("rev-parse", "HEAD"), hash);

    await assert.rejects(api.checkout({ dir: repo.dir, ref: "no-such-ref" }), /checkout no-such-ref failed/u);
    await assert.rejects(api.checkout({ dir: repo.dir, ref: "  " }), /a branch or revision is required/u);
  });
});

test("checkout/remote-branch-creates-tracking-branch", async () => {
  const bare = makeTempDir("git-for-claude-bare-");
  const cloneDir = makeTempDir("git-for-claude-clone-");
  try {
    git(bare, "init", "-q", "--bare");
    await withRepo({ "a.txt": "one\n" }, async (seed) => {
      seed.git("remote", "add", "origin", bare);
      seed.git("push", "-q", "-u", "origin", "main");
      seed.git("checkout", "-q", "-b", "feature/tracking");
      seed.write("b.txt", "bee\n");
      seed.git("add", "-A");
      seed.git("commit", "-q", "-m", "tracking work");
      seed.git("push", "-q", "-u", "origin", "feature/tracking");
      cloneRepo(bare, cloneDir);

      const result = await api.checkout({ dir: cloneDir, ref: "origin/feature/tracking" });
      assert.deepEqual(result, { ok: true, detached: false, branch: "feature/tracking" });
      assert.equal(git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD"), "feature/tracking");
      assert.equal(
        git(cloneDir, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
        "origin/feature/tracking",
      );
      // A second checkout of the same remote ref must reuse the local branch.
      await api.checkout({ dir: cloneDir, ref: "main" });
      const again = await api.checkout({ dir: cloneDir, ref: "origin/feature/tracking" });
      assert.equal(again.branch, "feature/tracking");
      assert.equal(git(cloneDir, "rev-parse", "--abbrev-ref", "HEAD"), "feature/tracking");
    });
  } finally {
    removeTempDir(bare);
    removeTempDir(cloneDir);
  }
});

/* ================================================================== *
 * 10. merge / cherryPick / revert / rebase / abortOperation.
 * ================================================================== */

test("merge/fast-forward-and-no-ff", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.git("checkout", "-q", "-b", "feature");
    repo.write("b.txt", "bee\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "feature work");
    const featureHead = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "-q", "main");

    const ff = await api.merge({ dir: repo.dir, ref: "feature" });
    assert.equal(ff.ok, true);
    assert.equal(ff.conflicts, false);
    assert.equal(repo.git("rev-parse", "HEAD"), featureHead);
    assert.equal(repo.git("rev-list", "--parents", "-1", "HEAD").split(" ").length, 2, "fast-forward has one parent");

    repo.git("checkout", "-q", "-b", "feature2");
    repo.write("c.txt", "cee\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "feature2 work");
    repo.git("checkout", "-q", "main");
    const noFf = await api.merge({ dir: repo.dir, ref: "feature2", noFf: true });
    assert.equal(noFf.ok, true);
    assert.equal(repo.git("rev-list", "--parents", "-1", "HEAD").split(" ").length, 3, "no-ff merge has two parents");
  });
});

test("merge/conflict-then-abort-operation", async () => {
  await withRepo({ "c.txt": "base\n" }, async (repo) => {
    repo.git("checkout", "-q", "-b", "other");
    repo.write("c.txt", "other\n");
    repo.git("commit", "-q", "-a", "-m", "other");
    repo.git("checkout", "-q", "main");
    repo.write("c.txt", "main\n");
    repo.git("commit", "-q", "-a", "-m", "main");

    const merged = await api.merge({ dir: repo.dir, ref: "other" });
    assert.equal(merged.ok, false);
    assert.equal(merged.conflicts, true);
    assert.match(merged.stdout + merged.stderr, /CONFLICT/u);
    assert.equal((await api.status({ dir: repo.dir })).inProgress.merge, true);

    const aborted = await api.abortOperation({ dir: repo.dir, kind: "merge" });
    assert.deepEqual(aborted, { ok: true });
    const status = await api.status({ dir: repo.dir });
    assert.deepEqual(status.inProgress, { merge: false, rebase: false, cherryPick: false, revert: false });
    assert.deepEqual(statusV1(repo.dir), []);
    assert.equal(repo.tryGit("rev-parse", "-q", "--verify", "MERGE_HEAD").code, 1);
  });
});

// HOST-13: `git merge <unknown-ref>` exits 1 ("not something we can merge"),
// which merge() maps to conflicts:true instead of rejecting with the git
// diagnostic. Callers cannot tell a bad ref from a real merge conflict.
test("merge/bad-ref-rejects-with-a-useful-message", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    await assert.rejects(api.merge({ dir: repo.dir, ref: "no-such-branch" }), /not something we can merge|no-such-branch/u);
    await assert.rejects(api.merge({ dir: repo.dir, ref: "" }), /a branch or revision is required/u);
  });
});

test("cherryPick/success-and-conflict-abort", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.git("checkout", "-q", "-b", "side");
    repo.write("side.txt", "side\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "side commit");
    const sideHash = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "-q", "main");

    const picked = await api.cherryPick({ dir: repo.dir, hash: sideHash });
    assert.equal(picked.ok, true);
    assert.equal(repo.git("log", "-1", "--pretty=format:%s"), "side commit");
    assert.equal(repo.exists("side.txt"), true);
    assert.deepEqual((await api.status({ dir: repo.dir })).inProgress, {
      merge: false,
      rebase: false,
      cherryPick: false,
      revert: false,
    });

    // Conflicting cherry-pick.
    repo.git("checkout", "-q", "-b", "conflict-side");
    repo.write("a.txt", "conflict side\n");
    repo.git("commit", "-q", "-a", "-m", "conflict side");
    const conflicting = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "-q", "main");
    repo.write("a.txt", "main changed\n");
    repo.git("commit", "-q", "-a", "-m", "main changed");
    const conflict = await api.cherryPick({ dir: repo.dir, hash: conflicting });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflicts, true);
    assert.equal((await api.status({ dir: repo.dir })).inProgress.cherryPick, true);
    await api.abortOperation({ dir: repo.dir, kind: "cherryPick" });
    assert.deepEqual(statusV1(repo.dir), []);
  });
});

test("revert/success-and-conflict-abort", async () => {
  await withRepo({ "a.txt": "base\n" }, async (repo) => {
    repo.write("a.txt", "second\n");
    repo.git("commit", "-q", "-a", "-m", "second");
    const second = repo.git("rev-parse", "HEAD");
    const reverted = await api.revert({ dir: repo.dir, hash: second });
    assert.equal(reverted.ok, true);
    assert.match(repo.git("log", "-1", "--pretty=format:%s"), /^Revert /u);
    assert.equal(repo.read("a.txt"), "base\n");

    // Conflicting revert: revert an older commit whose change no longer applies.
    repo.write("a.txt", "third\n");
    repo.git("commit", "-q", "-a", "-m", "third");
    const third = repo.git("rev-parse", "HEAD");
    repo.write("a.txt", "fourth\n");
    repo.git("commit", "-q", "-a", "-m", "fourth");
    const conflict = await api.revert({ dir: repo.dir, hash: third });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflicts, true);
    assert.equal((await api.status({ dir: repo.dir })).inProgress.revert, true);
    await api.abortOperation({ dir: repo.dir, kind: "revert" });
    assert.deepEqual(statusV1(repo.dir), []);
  });
});

test("rebase/success-and-conflict-abort", async () => {
  await withRepo({ "c.txt": "base\n" }, async (repo) => {
    repo.git("checkout", "-q", "-b", "topic");
    repo.write("topic.txt", "topic\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "topic commit");
    repo.git("checkout", "-q", "main");
    repo.write("main.txt", "main\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "main commit");
    const mainHead = repo.git("rev-parse", "HEAD");
    repo.git("checkout", "-q", "topic");

    const rebased = await api.rebase({ dir: repo.dir, onto: "main" });
    assert.equal(rebased.ok, true);
    assert.equal(repo.git("log", "-1", "--pretty=format:%s"), "topic commit");
    assert.equal(repo.git("rev-parse", "HEAD^"), mainHead);
    assert.deepEqual((await api.status({ dir: repo.dir })).inProgress, {
      merge: false,
      rebase: false,
      cherryPick: false,
      revert: false,
    });

    // Conflicting rebase.
    repo.git("checkout", "-q", "-b", "conflict-topic", "main~1");
    repo.write("c.txt", "conflict topic\n");
    repo.git("commit", "-q", "-a", "-m", "conflict topic");
    repo.git("checkout", "-q", "main");
    repo.write("c.txt", "conflict main\n");
    repo.git("commit", "-q", "-a", "-m", "conflict main");
    repo.git("checkout", "-q", "conflict-topic");
    const conflict = await api.rebase({ dir: repo.dir, onto: "main" });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.conflicts, true);
    assert.equal((await api.status({ dir: repo.dir })).inProgress.rebase, true);
    await api.abortOperation({ dir: repo.dir, kind: "rebase" });
    assert.deepEqual(statusV1(repo.dir), []);
  });
});

test("abortOperation/unknown-kind-and-nothing-in-progress", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    await assert.rejects(api.abortOperation({ dir: repo.dir, kind: "nope" }), /unknown operation "nope"/u);
    await assert.rejects(api.abortOperation({ dir: repo.dir, kind: "merge" }), /no operation in progress|MERGE_HEAD/u);
  });
});

/* ================================================================== *
 * 11. reset.
 * ================================================================== */

test("reset/soft-mixed-hard-and-default-mode", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.write("a.txt", "one\ntwo\n");
    repo.git("commit", "-q", "-a", "-m", "second");
    repo.write("a.txt", "one\ntwo\nthree\n");
    repo.git("commit", "-q", "-a", "-m", "third");
    const second = repo.git("rev-parse", "HEAD~1");

    await api.reset({ dir: repo.dir, ref: second, mode: "soft" });
    assert.equal(repo.git("rev-parse", "HEAD"), second);
    assert.deepEqual(statusV1(repo.dir), ["M  a.txt"]);
    assert.equal(indexContent(repo.dir, "a.txt"), "one\ntwo\nthree\n");
    assert.equal(fileText(repo.dir, "a.txt"), "one\ntwo\nthree\n");

    await api.reset({ dir: repo.dir, ref: second, mode: "mixed" });
    assert.equal(repo.git("rev-parse", "HEAD"), second);
    assert.deepEqual(statusV1(repo.dir), [" M a.txt"]);
    assert.equal(indexContent(repo.dir, "a.txt"), "one\ntwo\n");
    assert.equal(fileText(repo.dir, "a.txt"), "one\ntwo\nthree\n");

    await api.reset({ dir: repo.dir, ref: second, mode: "hard" });
    assert.equal(repo.git("rev-parse", "HEAD"), second);
    assert.deepEqual(statusV1(repo.dir), []);
    assert.equal(fileText(repo.dir, "a.txt"), "one\ntwo\n");

    // default mode is mixed and default ref is HEAD
    repo.write("a.txt", "dirty\n");
    repo.git("add", "a.txt");
    await api.reset({ dir: repo.dir });
    assert.equal(repo.git("rev-parse", "HEAD"), second);
    assert.deepEqual(statusV1(repo.dir), [" M a.txt"]);
    assert.equal(indexContent(repo.dir, "a.txt"), "one\ntwo\n");
  });
});

test("reset/bad-ref-rejects", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    await assert.rejects(api.reset({ dir: repo.dir, ref: "definitely-not-a-ref" }), /reset --mixed definitely-not-a-ref failed/u);
  });
});

/* ================================================================== *
 * 12. log / show / reflog / tags.
 * ================================================================== */

test("log/paging-order-and-unborn", async () => {
  await withRepo({ "seed.txt": "seed\n" }, async (repo) => {
    for (let index = 2; index <= 5; index += 1) {
      repo.write(`f${String(index)}.txt`, `${String(index)}\n`);
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", `commit ${String(index)}`);
    }
    const allSubjects = repo.git("log", "--pretty=format:%s").split("\n");
    assert.deepEqual(allSubjects, ["commit 5", "commit 4", "commit 3", "commit 2", "initial"]);

    const firstPage = await api.log({ dir: repo.dir, limit: 2 });
    assert.deepEqual(firstPage.commits.map((commit) => commit.subject), allSubjects.slice(0, 2));
    assert.equal(firstPage.commits[0].hash, repo.git("rev-parse", "HEAD"));
    assert.equal(firstPage.commits[0].shortHash, repo.git("rev-parse", "--short", "HEAD"));
    assert.equal(firstPage.commits[0].author, "Test User");
    assert.equal(firstPage.commits[0].date.length > 0, true);
    assert.match(firstPage.commits[0].decorations, /HEAD ->/u);
    assert.equal(firstPage.hasMore, true);

    const secondPage = await api.log({ dir: repo.dir, skip: 2, limit: 2 });
    assert.deepEqual(secondPage.commits.map((commit) => commit.subject), allSubjects.slice(2, 4));

    const pastEnd = await api.log({ dir: repo.dir, skip: 10, limit: 2 });
    assert.deepEqual(pastEnd, { commits: [], hasMore: false });
  });
});

test("log/unborn-head-returns-empty", async () => {
  await withRepo({}, async (repo) => {
    assert.deepEqual(await api.log({ dir: repo.dir }), { commits: [], hasMore: false });
    assert.deepEqual(await api.reflog({ dir: repo.dir }), { entries: [] });
    assert.deepEqual(await api.branches({ dir: repo.dir }), { local: [], remote: [] });
  }, { initialCommit: false });
});

// HOST-09: hasMore is computed as "page is exactly full", not "more commits
// exist". The last page of a log therefore reports hasMore:true forever and a
// pager shows a spinner / issues one useless extra fetch.
test("log/hasMore-false-on-the-last-page", async () => {
  await withRepo({ "seed.txt": "seed\n" }, async (repo) => {
    for (let index = 2; index <= 5; index += 1) {
      repo.write(`f${String(index)}.txt`, `${String(index)}\n`);
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", `commit ${String(index)}`);
    }
    const total = Number(repo.git("rev-list", "--count", "HEAD"));
    assert.equal(total, 5);
    const lastPage = await api.log({ dir: repo.dir, skip: total - 2, limit: 2 });
    assert.equal(lastPage.commits.length, 2);
    assert.equal(lastPage.hasMore, false, `no commits remain after this page but hasMore=${String(lastPage.hasMore)}`);
  });
});

test("show/metadata-and-patch", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    const message = "show subject\n\nshow body line";
    repo.write("a.txt", "one\ntwo\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", message);

    const shown = await api.show({ dir: repo.dir, hash: "HEAD" });
    assert.equal(shown.hash, repo.git("rev-parse", "HEAD"));
    assert.equal(shown.author, "Test User");
    assert.equal(shown.email, "test@example.com");
    assert.equal(shown.subject, "show subject");
    assert.equal(shown.body.trimEnd(), message);
    assert.equal(shown.date.length > 0, true);
    assert.match(shown.patch, /diff --git a\/a\.txt b\/a\.txt/u);
    assert.match(shown.patch, /^\+two$/mu);
    assert.match(shown.patch, /a\.txt \|/u, "patch includes the --stat section");
    assert.equal(typeof shown.decorations, "string");
    await assert.rejects(api.show({ dir: repo.dir, hash: "nope" }), /git show nope failed/u);
    await assert.rejects(api.show({ dir: repo.dir, hash: "" }), /git\/show: a commit is required/u);
  });
});

// HOST-08: `show.body` is the raw `%B` field, which still carries the format
// terminator, while `lastCommitMessage` strips it. The two APIs disagree about
// the same commit message by one trailing newline.
test("show/body-matches-lastCommitMessage", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    const message = "show subject\n\nshow body line";
    repo.write("a.txt", "one\ntwo\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", message);
    const shown = await api.show({ dir: repo.dir, hash: "HEAD" });
    const last = await api.lastCommitMessage({ dir: repo.dir });
    assert.equal(JSON.stringify(shown.body), JSON.stringify(message), `show.body has a trailing newline: ${JSON.stringify(shown.body)}`);
    assert.equal(shown.body, last.message);
  });
});

test("reflog/limit-and-entry-fields", async () => {
  await withRepo({ "seed.txt": "seed\n" }, async (repo) => {
    for (let index = 2; index <= 4; index += 1) {
      repo.write(`f${String(index)}.txt`, `${String(index)}\n`);
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", `commit ${String(index)}`);
    }
    const expected = repo
      .git("reflog", "--format=%h%x09%gs", "--max-count=2")
      .split("\n")
      .map((line) => line.split("\t"));
    const reflog = await api.reflog({ dir: repo.dir, limit: 2 });
    assert.equal(reflog.entries.length, 2);
    assert.deepEqual(
      reflog.entries.map((entry) => [entry.shortHash, entry.subject]),
      expected,
    );
    assert.equal(reflog.entries[0].selector.startsWith("HEAD@{"), true);
    const single = await api.reflog({ dir: repo.dir, limit: 1 });
    assert.equal(single.entries.length, 1);
    assert.equal(single.entries[0].selector, reflog.entries[0].selector);
  });
});

test("tags/lightweight-annotated-ref-and-delete", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.git("commit", "-q", "--allow-empty", "-m", "second");
    await api.createTag({ dir: repo.dir, name: "light" });
    await api.createTag({ dir: repo.dir, name: "annotated", message: "annotated message" });
    await api.createTag({ dir: repo.dir, name: "old", ref: "HEAD~1" });

    const tags = (await api.tags({ dir: repo.dir })).tags;
    assert.deepEqual(
      tags.map((tag) => tag.name).sort(),
      ["annotated", "light", "old"],
    );
    for (const tag of tags) {
      assert.equal(tag.tip, repo.git("rev-parse", "--short", `${tag.name}^{commit}`));
      assert.equal(tag.date.length > 0, true);
    }
    assert.equal(tags.find((tag) => tag.name === "annotated").subject, "annotated message");
    assert.equal(tags.find((tag) => tag.name === "light").subject, "second");
    assert.equal(tags.find((tag) => tag.name === "old").tip, repo.git("rev-parse", "--short", "HEAD~1^{commit}"));

    await api.deleteTag({ dir: repo.dir, name: "old" });
    assert.deepEqual(
      (await api.tags({ dir: repo.dir })).tags.map((tag) => tag.name).sort(),
      ["annotated", "light"],
    );
    await assert.rejects(api.createTag({ dir: repo.dir, name: "" }), /a tag name is required/u);
    await assert.rejects(api.deleteTag({ dir: repo.dir, name: "" }), /a tag name is required/u);
  });
});

/* ================================================================== *
 * 13. stash.
 * ================================================================== */

test("stash/save-list-apply-pop-including-untracked", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.write("a.txt", "one\nstashed change\n");
    const saved = await api.stashSave({ dir: repo.dir, message: "my stash" });
    assert.equal(saved.ok, true);
    assert.deepEqual(statusV1(repo.dir), []);

    let list = await api.stashList({ dir: repo.dir });
    assert.equal(list.stashes.length, 1);
    assert.deepEqual(
      { index: list.stashes[0].index, ref: list.stashes[0].ref },
      { index: 0, ref: "stash@{0}" },
    );
    assert.match(list.stashes[0].message, /my stash/u);
    assert.equal(list.stashes[0].date.length > 0, true);

    const applied = await api.stashApply({ dir: repo.dir, index: 0 });
    assert.equal(applied.ok, true);
    assert.equal(repo.read("a.txt"), "one\nstashed change\n");
    assert.equal((await api.stashList({ dir: repo.dir })).stashes.length, 1, "apply keeps the entry");
    // Drop the applied worktree change before popping the same entry again.
    repo.git("checkout", "--", "a.txt");

    const popped = await api.stashPop({ dir: repo.dir, index: 0 });
    assert.equal(popped.ok, true);
    assert.deepEqual(statusV1(repo.dir), [" M a.txt"]);
    assert.deepEqual((await api.stashList({ dir: repo.dir })).stashes, []);

    // Untracked files only enter a stash when includeUntracked is requested.
    repo.git("checkout", "--", "a.txt");
    repo.write("u.txt", "untracked stash\n");
    await api.stashSave({ dir: repo.dir, message: "tracked only" });
    assert.equal(repo.exists("u.txt"), true, "untracked file survives a tracked-only stash");
    await api.stashPop({ dir: repo.dir, index: 0 });
    repo.write("a.txt", "one\nmodified\n");
    const withUntracked = await api.stashSave({ dir: repo.dir, message: "with untracked", includeUntracked: true });
    assert.equal(withUntracked.ok, true);
    assert.equal(repo.exists("u.txt"), false, "includeUntracked stashes the untracked file");
    assert.deepEqual(statusV1(repo.dir), []);
    await api.stashPop({ dir: repo.dir, index: 0 });
    assert.equal(repo.exists("u.txt"), true);
    assert.equal(repo.read("u.txt"), "untracked stash\n");
  });
});

test("stash/index-selection-drop-and-invalid-index", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.write("a.txt", "first stash content\n");
    await api.stashSave({ dir: repo.dir, message: "stash one" });
    repo.write("a.txt", "second stash content\n");
    await api.stashSave({ dir: repo.dir, message: "stash two" });

    let list = await api.stashList({ dir: repo.dir });
    assert.equal(list.stashes.length, 2);
    assert.match(list.stashes[0].message, /stash two/u, "newest stash is index 0");
    assert.match(list.stashes[1].message, /stash one/u);

    const applied = await api.stashApply({ dir: repo.dir, index: 1 });
    assert.equal(applied.ok, true);
    assert.equal(repo.read("a.txt"), "first stash content\n");
    repo.git("checkout", "--", "a.txt");

    await api.stashDrop({ dir: repo.dir, index: 0 });
    list = await api.stashList({ dir: repo.dir });
    assert.equal(list.stashes.length, 1);
    assert.match(list.stashes[0].message, /stash one/u);

    await assert.rejects(api.stashApply({ dir: repo.dir, index: 9 }), /log for 'stash' only has|stash@\{9\}/u);
    assert.equal((await api.stashSave({ dir: repo.dir })).ok, true, "stashing nothing is not an error");
  });
});

/* ================================================================== *
 * 14. remotes / fetch / pull / push against a local bare remote.
 * ================================================================== */

test("remotes/parse-fetch-and-push-urls", async () => {
  const bare = makeTempDir("git-for-claude-bare-");
  const pushMirror = makeTempDir("git-for-claude-push-");
  try {
    git(bare, "init", "-q", "--bare");
    await withRepo({ "a.txt": "one\n" }, async (repo) => {
      repo.git("remote", "add", "origin", bare);
      repo.git("remote", "set-url", "--push", "origin", pushMirror);
      repo.git("remote", "add", "upstream", bare);
      const remotes = (await api.remotes({ dir: repo.dir })).remotes;
      assert.deepEqual(remotes.map((remote) => remote.name).sort(), ["origin", "upstream"]);
      const origin = remotes.find((remote) => remote.name === "origin");
      assert.equal(origin.fetchUrl, repo.git("remote", "get-url", "origin"));
      assert.equal(origin.pushUrl, repo.git("remote", "get-url", "--push", "origin"));
      assert.notEqual(origin.fetchUrl, origin.pushUrl);
      const upstream = remotes.find((remote) => remote.name === "upstream");
      assert.equal(upstream.fetchUrl, upstream.pushUrl);
    });
  } finally {
    removeTempDir(bare);
    removeTempDir(pushMirror);
  }
});

test("fetch/updates-remote-tracking-refs", async () => {
  const bare = makeTempDir("git-for-claude-bare-");
  const cloneDir = makeTempDir("git-for-claude-clone-");
  try {
    git(bare, "init", "-q", "--bare");
    await withRepo({ "a.txt": "one\n" }, async (seed) => {
      seed.git("remote", "add", "origin", bare);
      seed.git("push", "-q", "-u", "origin", "main");
      cloneRepo(bare, cloneDir);
      const before = git(cloneDir, "rev-parse", "origin/main");
      seed.write("a.txt", "one\ntwo\n");
      seed.git("commit", "-q", "-a", "-m", "second");
      seed.git("push", "-q", "origin", "main");
      const fetched = await api.fetch({ dir: cloneDir });
      assert.equal(fetched.ok, true);
      assert.equal(git(cloneDir, "rev-parse", "origin/main"), seed.git("rev-parse", "HEAD"));
      assert.notEqual(git(cloneDir, "rev-parse", "origin/main"), before);
      const single = await api.fetch({ dir: cloneDir, remote: "origin" });
      assert.equal(single.ok, true);
      await assert.rejects(api.fetch({ dir: cloneDir, remote: "nope" }), /does not appear to be a git repository/u);
    });
  } finally {
    removeTempDir(bare);
    removeTempDir(cloneDir);
  }
});

test("push/set-upstream-non-ff-and-force-with-lease", async () => {
  const bare = makeTempDir("git-for-claude-bare-");
  try {
    git(bare, "init", "-q", "--bare");
    await withRepo({ "a.txt": "one\n" }, async (repo) => {
      repo.git("remote", "add", "origin", bare);
      const pushed = await api.push({ dir: repo.dir, remote: "origin", branch: "main", setUpstream: true });
      assert.equal(pushed.ok, true);
      assert.equal(
        repo.git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
        "origin/main",
      );
      const firstRemoteSha = git(bare, "rev-parse", "refs/heads/main");
      assert.equal(firstRemoteSha, repo.git("rev-parse", "HEAD"));

      repo.git("commit", "-q", "--amend", "-m", "amended");
      const rejected = await api.push({ dir: repo.dir });
      assert.equal(rejected.ok, false);
      assert.equal(git(bare, "rev-parse", "refs/heads/main"), firstRemoteSha, "rejected push leaves remote untouched");

      const forced = await api.push({ dir: repo.dir, force: true });
      assert.equal(forced.ok, true);
      assert.equal(git(bare, "rev-parse", "refs/heads/main"), repo.git("rev-parse", "HEAD"));
      await assert.rejects(api.push({ dir: repo.dir, setUpstream: true }), /a remote is required to set an upstream/u);
    });
  } finally {
    removeTempDir(bare);
  }
});

test("pull/fast-forward-and-conflict-abort", async () => {
  const bare = makeTempDir("git-for-claude-bare-");
  const cloneDir = makeTempDir("git-for-claude-clone-");
  try {
    git(bare, "init", "-q", "--bare");
    await withRepo({ "a.txt": "one\n" }, async (seed) => {
      seed.git("remote", "add", "origin", bare);
      seed.git("push", "-q", "-u", "origin", "main");
      cloneRepo(bare, cloneDir);

      // Fast-forward pull.
      seed.write("a.txt", "one\ntwo\n");
      seed.git("commit", "-q", "-a", "-m", "seed second");
      seed.git("push", "-q", "origin", "main");
      const pulled = await api.pull({ dir: cloneDir });
      assert.equal(pulled.ok, true);
      assert.equal(pulled.conflicts, false);
      assert.equal(git(cloneDir, "rev-parse", "HEAD"), seed.git("rev-parse", "HEAD"));

      // Divergent pull produces a real merge conflict.
      writeFileSync(join(cloneDir, "a.txt"), "clone side\n");
      git(cloneDir, "commit", "-q", "-a", "-m", "clone side");
      seed.write("a.txt", "seed side\n");
      seed.git("commit", "-q", "-a", "-m", "seed side");
      seed.git("push", "-q", "origin", "main");
      const conflicted = await api.pull({ dir: cloneDir });
      assert.equal(conflicted.ok, false);
      assert.equal(conflicted.conflicts, true);
      const status = await api.status({ dir: cloneDir });
      assert.equal(status.inProgress.merge, true);
      assert.deepEqual(status.files, [{ path: "a.txt", x: "U", y: "U", kind: "unmerged" }]);
      await api.abortOperation({ dir: cloneDir, kind: "merge" });
      assert.deepEqual(statusV1(cloneDir), []);
    });
  } finally {
    removeTempDir(bare);
    removeTempDir(cloneDir);
  }
});

// HOST-11: `pull` maps every non-zero exit to `conflicts: true`. A repository
// with no upstream is a configuration error, not a merge conflict, and the UI
// reacts to `conflicts` by entering conflict-resolution mode.
test("pull/no-upstream-is-not-reported-as-a-conflict", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    const result = await api.pull({ dir: repo.dir });
    assert.equal(result.ok, false);
    assert.equal(
      result.conflicts,
      false,
      `pull without an upstream must not report conflicts=true (stderr: ${firstLine(result.stderr, 200)})`,
    );
  });
});

/* ================================================================== *
 * 15. worktrees / initRepo / run.
 * ================================================================== */

let worktreeSequence = 0;

/** Unique, not-yet-existing path outside any fixture repository. */
function worktreeFixture(label) {
  worktreeSequence += 1;
  return join(
    tmpdir(),
    `git-for-claude-wt-${label}-${String(process.pid)}-${String(Date.now())}-${String(worktreeSequence)}`,
  );
}

/** Remove a linked worktree through git when it still has admin files. */
function cleanupWorktree(repoDir, path) {
  gitTry(repoDir, ["worktree", "remove", "--force", "--", path]);
  gitTry(repoDir, ["worktree", "prune"]);
  removeTempDir(path);
}

test("worktrees/list-main-linked-and-detached", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.git("commit", "-q", "--allow-empty", "-m", "second");
    const head = repo.git("rev-parse", "HEAD");
    const linked = join(tmpdir(), `git-for-claude-wt-${String(Date.now())}-${String(Math.random()).slice(2)}`);
    const detached = join(tmpdir(), `git-for-claude-wt-detached-${String(Date.now())}-${String(Math.random()).slice(2)}`);
    try {
      repo.git("worktree", "add", "-q", "-b", "wtbranch", linked);
      repo.git("worktree", "add", "-q", "--detach", detached, "HEAD");
      const list = (await api.worktrees({ dir: repo.dir })).worktrees;
      assert.equal(list.length, 3);
      const main = list[0];
      assert.equal(main.path, repo.real);
      assert.equal(main.head, head);
      assert.equal(main.branch, "main");
      assert.equal(main.detached, false);
      const linkedRow = list.find((row) => row.path === realpathSync(linked));
      assert.ok(linkedRow, `linked worktree row missing; rows: ${JSON.stringify(list.map((row) => row.path))}`);
      assert.equal(linkedRow.branch, "wtbranch");
      assert.equal(linkedRow.head, head);
      assert.equal(linkedRow.detached, false);
      const detachedRow = list.find((row) => row.path === realpathSync(detached));
      assert.ok(detachedRow);
      assert.equal(detachedRow.detached, true);
      assert.equal(detachedRow.branch, null);
    } finally {
      gitTry(repo.dir, ["worktree", "remove", "--force", "--", linked]);
      gitTry(repo.dir, ["worktree", "remove", "--force", "--", detached]);
      removeTempDir(linked);
      removeTempDir(detached);
    }
  });
});

test("worktrees/flags-main-current-locked-prunable", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    const linked = worktreeFixture("flags");
    try {
      repo.git("worktree", "add", "-q", "-b", "wtflags", linked);
      const realLinked = realpathSync(linked);

      const fromMain = (await api.worktrees({ dir: repo.dir })).worktrees;
      assert.equal(fromMain.length, 2);
      assert.equal(fromMain[0].main, true, "first row is the main worktree");
      assert.equal(fromMain[0].isCurrent, true);
      assert.equal(fromMain[1].main, false);
      assert.equal(fromMain[1].isCurrent, false);
      assert.equal(fromMain[1].locked, false);
      assert.equal(fromMain[1].prunable, false);

      // The panel's notion of "current" follows the directory it was given.
      const fromLinked = (await api.worktrees({ dir: linked })).worktrees;
      assert.equal(fromLinked[0].main, true, "main stays the first row");
      assert.equal(fromLinked[0].isCurrent, false);
      const linkedRow = fromLinked.find((row) => row.path === realLinked);
      assert.ok(linkedRow);
      assert.equal(linkedRow.isCurrent, true);

      await api.lockWorktree({ dir: repo.dir, path: linked, reason: "on purpose" });
      const locked = (await api.worktrees({ dir: repo.dir })).worktrees.find((row) => row.path === realLinked);
      assert.equal(locked.locked, true);
      assert.equal(locked.lockReason, "on purpose");
      assert.equal(locked.prunable, false, "a locked worktree is never prunable");

      await api.unlockWorktree({ dir: repo.dir, path: linked });
      const unlocked = (await api.worktrees({ dir: repo.dir })).worktrees.find((row) => row.path === realLinked);
      assert.equal(unlocked.locked, false);
      assert.equal(unlocked.lockReason, "");
    } finally {
      cleanupWorktree(repo.dir, linked);
    }
  });
});

test("worktrees/add-existing-branch-then-remove", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.git("branch", "other");
    const linked = worktreeFixture("existing");
    try {
      const added = await api.addWorktree({ dir: repo.dir, path: linked, branch: "other" });
      assert.equal(added.ok, true);
      assert.equal(existsSync(join(linked, "a.txt")), true, "the new worktree is checked out");
      assert.equal(readFileSync(join(linked, "a.txt"), "utf8"), "one\n");

      const rows = (await api.worktrees({ dir: repo.dir })).worktrees;
      const row = rows.find((entry) => entry.path === realpathSync(linked));
      assert.ok(row);
      assert.equal(row.branch, "other");
      assert.equal(row.head, repo.git("rev-parse", "HEAD"));

      const removed = await api.removeWorktree({ dir: repo.dir, path: linked });
      assert.equal(removed.ok, true);
      assert.equal(existsSync(linked), false, "the directory is gone");
      assert.equal((await api.worktrees({ dir: repo.dir })).worktrees.length, 1);
    } finally {
      cleanupWorktree(repo.dir, linked);
    }
  });
});

test("worktrees/add-new-branch-and-detached", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    const branch = repo.git("rev-parse", "--abbrev-ref", "HEAD");
    repo.git("commit", "-q", "--allow-empty", "-m", "second");
    const head = repo.git("rev-parse", "HEAD");
    const first = repo.git("rev-parse", "HEAD~1");
    const created = worktreeFixture("newbranch");
    const detached = worktreeFixture("detached");
    try {
      await api.addWorktree({ dir: repo.dir, path: created, branch: "feature/wt", createBranch: true });
      const createdRow = (await api.worktrees({ dir: repo.dir })).worktrees.find(
        (row) => row.path === realpathSync(created),
      );
      assert.ok(createdRow);
      assert.equal(createdRow.branch, "feature/wt");
      assert.equal(createdRow.detached, false);
      assert.equal(createdRow.head, head);
      assert.equal(repo.git("rev-parse", "refs/heads/feature/wt"), head);
      assert.equal(branch, "main");

      await api.addWorktree({ dir: repo.dir, path: detached, branch: "HEAD", detached: true, start: first });
      const detachedRow = (await api.worktrees({ dir: repo.dir })).worktrees.find(
        (row) => row.path === realpathSync(detached),
      );
      assert.ok(detachedRow);
      assert.equal(detachedRow.detached, true);
      assert.equal(detachedRow.branch, null);
      assert.equal(detachedRow.head, first);
      assert.equal(repo.git("-C", detached, "rev-parse", "HEAD"), first);
    } finally {
      cleanupWorktree(repo.dir, created);
      cleanupWorktree(repo.dir, detached);
    }
  });
});

test("worktrees/add-rejects-unsafe-and-impossible-requests", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    repo.git("branch", "other");
    const linked = worktreeFixture("invalid");
    try {
      await assert.rejects(api.addWorktree({ dir: repo.dir, path: "-rf", branch: "other" }), /cannot start with "-"/u);
      await assert.rejects(api.addWorktree({ dir: repo.dir, path: linked }), /branch name is required/u);
      await assert.rejects(
        api.addWorktree({ dir: repo.dir, path: linked, branch: "new", createBranch: true, detached: true }),
        /mutually exclusive/u,
      );

      await api.addWorktree({ dir: repo.dir, path: linked, branch: "other" });
      // The path already exists.
      await assert.rejects(api.addWorktree({ dir: repo.dir, path: linked, branch: "main" }), /already exists/iu);
      // The branch is checked out in the linked worktree already.
      const second = worktreeFixture("second");
      await assert.rejects(
        api.addWorktree({ dir: repo.dir, path: second, branch: "other" }),
        /already (?:checked out|used by worktree)/iu,
      );
      removeTempDir(second);
    } finally {
      cleanupWorktree(repo.dir, linked);
    }
  });
});

test("worktrees/remove-dirty-requires-force", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    const linked = worktreeFixture("dirty");
    try {
      await api.addWorktree({ dir: repo.dir, path: linked, branch: "dirty", createBranch: true });
      writeFileSync(join(linked, "scratch.txt"), "unsaved\n");
      await assert.rejects(api.removeWorktree({ dir: repo.dir, path: linked }), /modified or untracked|--force/iu);
      assert.equal(existsSync(linked), true, "a refused remove leaves the directory");

      const forced = await api.removeWorktree({ dir: repo.dir, path: linked, force: true });
      assert.equal(forced.ok, true);
      assert.equal(existsSync(linked), false);
    } finally {
      cleanupWorktree(repo.dir, linked);
    }
  });
});

test("worktrees/remove-main-is-refused-and-locked-blocks-remove", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    const linked = worktreeFixture("locked-remove");
    try {
      await assert.rejects(api.removeWorktree({ dir: repo.dir, path: repo.dir }), /main working tree/iu);

      await api.addWorktree({ dir: repo.dir, path: linked, branch: "locked", createBranch: true });
      await api.lockWorktree({ dir: repo.dir, path: linked });
      await assert.rejects(api.removeWorktree({ dir: repo.dir, path: linked, force: true }), /locked/iu);
      assert.equal(existsSync(linked), true);

      await api.unlockWorktree({ dir: repo.dir, path: linked });
      await api.removeWorktree({ dir: repo.dir, path: linked });
      assert.equal(existsSync(linked), false);
    } finally {
      cleanupWorktree(repo.dir, linked);
    }
  });
});

test("worktrees/move-updates-the-listing", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    const before = worktreeFixture("move-from");
    const after = worktreeFixture("move-to");
    try {
      await api.addWorktree({ dir: repo.dir, path: before, branch: "moving", createBranch: true });
      const realBefore = realpathSync(before);
      const moved = await api.moveWorktree({ dir: repo.dir, from: before, to: after });
      assert.equal(moved.ok, true);
      assert.equal(existsSync(before), false);
      assert.equal(existsSync(join(after, "a.txt")), true);

      const rows = (await api.worktrees({ dir: repo.dir })).worktrees;
      assert.equal(rows.some((row) => row.path === realpathSync(after)), true, `rows: ${JSON.stringify(rows.map((row) => row.path))}`);
      assert.equal(rows.some((row) => row.path === realBefore), false);
      assert.equal((await api.status({ dir: after })).isRepo, true, "the moved worktree still resolves as a repo");
    } finally {
      cleanupWorktree(repo.dir, before);
      cleanupWorktree(repo.dir, after);
    }
  });
});

test("worktrees/prune-previews-then-removes-missing-checkouts", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    const linked = worktreeFixture("prune");
    try {
      await api.addWorktree({ dir: repo.dir, path: linked, branch: "stale", createBranch: true });
      const realLinked = realpathSync(linked);
      rmSync(linked, { recursive: true, force: true });
      const prunable = (await api.worktrees({ dir: repo.dir })).worktrees.find((row) => row.path === realLinked);
      assert.ok(prunable, `prunable row missing: ${JSON.stringify((await api.worktrees({ dir: repo.dir })).worktrees.map((row) => row.path))}`);
      assert.equal(prunable.prunable, true);
      assert.match(prunable.prunableReason, /non-existent/iu);

      const preview = await api.pruneWorktrees({ dir: repo.dir, dryRun: true });
      assert.match(preview.output, /Would remove/u);
      assert.equal(
        (await api.worktrees({ dir: repo.dir })).worktrees.some((row) => row.path === realLinked),
        true,
        "a dry run must not prune",
      );

      const pruned = await api.pruneWorktrees({ dir: repo.dir });
      assert.match(pruned.output, /Removing/u);
      assert.equal(
        (await api.worktrees({ dir: repo.dir })).worktrees.some((row) => row.path === realLinked),
        false,
        "the stale record is gone",
      );
    } finally {
      cleanupWorktree(repo.dir, linked);
    }
  });
});

test("worktrees/operations-reject-outside-a-repository", async () => {
  await withPlainDir(async (dir) => {
    await assert.rejects(api.worktrees({ dir }), /not a git repository/iu);
    await assert.rejects(api.addWorktree({ dir, path: join(dir, "wt"), branch: "main" }), /not a git repository/iu);
    await assert.rejects(api.removeWorktree({ dir, path: join(dir, "wt") }), /not a git repository/iu);
    await assert.rejects(api.pruneWorktrees({ dir }), /not a git repository/iu);
    await assert.rejects(api.lockWorktree({ dir, path: join(dir, "wt") }), /not a git repository/iu);
    await assert.rejects(api.unlockWorktree({ dir, path: join(dir, "wt") }), /not a git repository/iu);
    await assert.rejects(api.moveWorktree({ dir, from: join(dir, "a"), to: join(dir, "b") }), /not a git repository/iu);
  });
});

test("initRepo/creates-repository-and-is-idempotent", async () => {
  await withPlainDir(async (dir) => {
    const before = await api.status({ dir });
    assert.equal(before.isRepo, false);
    assert.match(before.error, /not a git repository/iu);
    const initialized = await api.initRepo({ dir });
    assert.equal(initialized.ok, true);
    const after = await api.status({ dir });
    assert.equal(after.isRepo, true);
    assert.equal(after.branch.initial, true);
    assert.deepEqual(after.files, []);
    const again = await api.initRepo({ dir });
    assert.equal(again.ok, true);
    assert.equal((await api.status({ dir })).isRepo, true);
  });
});

test("run/argv-stdin-and-no-shell", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    const plain = await api.run({ dir: repo.dir, args: ["rev-parse", "--abbrev-ref", "HEAD"] });
    assert.equal(plain.ok, true);
    assert.equal(plain.stdout.trim(), "main");
    assert.equal(plain.stderr, "");

    // No shell: $(…) is a literal argv element and must not be executed.
    let rejected = false;
    try {
      await api.run({ dir: repo.dir, args: ["rev-parse", "$(touch pwned)"] });
    } catch (error) {
      rejected = true;
      assert.match(error.message, /rev-parse/u);
    }
    assert.equal(rejected, true);
    assert.equal(existsSync(join(repo.dir, "pwned")), false);

    // stdin passthrough.
    const hashed = await api.run({ dir: repo.dir, args: ["hash-object", "-w", "--stdin"], stdin: "hello via stdin\n" });
    const objectId = hashed.stdout.trim();
    assert.match(objectId, /^[0-9a-f]{40,64}$/u);
    assert.equal(git(repo.dir, "cat-file", "-p", objectId), "hello via stdin");

    await assert.rejects(api.run({ dir: repo.dir, args: [] }), /non-empty array of strings/u);
    await assert.rejects(api.run({ dir: repo.dir, args: ["log", 1] }), /non-empty array of strings/u);
    await assert.rejects(api.run({ dir: repo.dir, args: ["not-a-git-subcommand"] }), /is not a git command/u);
  });
});

test("run/non-repository-rejects", async () => {
  await withPlainDir(async (dir) => {
    await assert.rejects(api.run({ dir, args: ["status"] }), /not a git repository/iu);
  });
});

/* ================================================================== *
 * 16. error paths on a non-repository and malformed requests.
 * ================================================================== */

test("errors/mutations-on-non-repository-reject", async () => {
  await withPlainDir(async (dir) => {
    const status = await api.status({ dir });
    assert.equal(status.isRepo, false);
    assert.match(status.error, /not a git repository/iu);
    await assert.rejects(api.stage({ dir }), /not a git repository/iu);
    await assert.rejects(api.diff({ dir, path: "a.txt" }), /not a git repository/iu);
    await assert.rejects(api.log({ dir }), /not a git repository/iu);
    await assert.rejects(api.commit({ dir, message: "x" }), /not a git repository/iu);
    await assert.rejects(api.initRepo({}), /a directory is required/u);
  });
});

test("errors/request-validation-messages", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    await assert.rejects(api.discard({ dir: repo.dir, paths: [] }), /at least one path is required/u);
    await assert.rejects(api.stageLines({ dir: repo.dir }), /the displayed diff is required/u);
    await assert.rejects(api.renameBranch({ dir: repo.dir, from: "a", to: "" }), /both branch names are required/u);
    await assert.rejects(api.rebase({ dir: repo.dir, onto: "" }), /a branch or revision is required/u);
    await assert.rejects(api.cherryPick({ dir: repo.dir, hash: "" }), /a commit hash is required/u);
    await assert.rejects(api.revert({ dir: repo.dir, hash: "" }), /a commit hash is required/u);
    await assert.rejects(api.show({ dir: repo.dir, hash: "" }), /git\/show: a commit is required/u);
  });
});

/* ================================================================== *
 * 17. Image preview.
 * ================================================================== */

/** 1×1 PNGs with different pixels, used as binary fixtures. */
const PNG_RED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  "base64",
);
const PNG_BLUE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC",
  "base64",
);

/** Decode the base64 payload of one image side. */
function imageBytes(side) {
  return Buffer.from(side.dataUrl.slice(side.dataUrl.indexOf(",") + 1), "base64");
}

test("image/worktree-and-staged-before-after", async () => {
  await withRepo({ "img/a.png": PNG_RED }, async (repo) => {
    repo.write("img/a.png", PNG_BLUE);

    const working = await api.image({ dir: repo.dir, path: "img/a.png" });
    assert.equal(working.mime, "image/png");
    assert.equal(working.before.bytes, PNG_RED.length);
    assert.equal(working.after.bytes, PNG_BLUE.length);
    assert.deepEqual(imageBytes(working.before), PNG_RED, "before is the index version");
    assert.deepEqual(imageBytes(working.after), PNG_BLUE, "after is the worktree version");
    assert.match(working.before.dataUrl, /^data:image\/png;base64,/u);

    repo.git("add", "--", "img/a.png");
    const staged = await api.image({ dir: repo.dir, path: "img/a.png", staged: true });
    assert.deepEqual(imageBytes(staged.before), PNG_RED, "staged before is HEAD");
    assert.deepEqual(imageBytes(staged.after), PNG_BLUE, "staged after is the index");
  });
});

test("image/untracked-deleted-and-svg", async () => {
  await withRepo({ "gone.png": PNG_RED, "logo.svg": "<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>" }, async (repo) => {
    rmSync(repo.path("gone.png"));
    const deleted = await api.image({ dir: repo.dir, path: "gone.png" });
    assert.equal(deleted.before.bytes, PNG_RED.length);
    assert.equal(deleted.after, null, "a deleted worktree file has no after side");

    repo.write("new.png", PNG_BLUE);
    const untracked = await api.image({ dir: repo.dir, path: "new.png", untracked: true });
    assert.equal(untracked.before, null);
    assert.deepEqual(imageBytes(untracked.after), PNG_BLUE);

    repo.write("logo.svg", "<svg xmlns='http://www.w3.org/2000/svg' width='2' height='2'/>");
    const svg = await api.image({ dir: repo.dir, path: "logo.svg" });
    assert.equal(svg.mime, "image/svg+xml");
    assert.match(imageBytes(svg.after).toString("utf8"), /width='2'/u);
  });
});

test("image/rejects-non-images-and-escaping-paths", async () => {
  await withRepo({ "a.txt": "one\n" }, async (repo) => {
    await assert.rejects(api.image({ dir: repo.dir, path: "a.txt" }), /not a previewable image/u);
    await assert.rejects(api.image({ dir: repo.dir, path: "../escape.png" }), /cannot leave the repository/u);
    await assert.rejects(api.image({ dir: repo.dir, path: "/tmp/x.png" }), /repository-relative path/u);
    await assert.rejects(api.image({ dir: repo.dir, path: "-rf.png" }), /cannot start with "-"/u);
  });
  await withPlainDir(async (dir) => {
    await assert.rejects(api.image({ dir, path: "a.png" }), /not a git repository/iu);
  });
});

/* ================================================================== *
 * Run.
 * ================================================================== */

note("known product bugs are documented in test/host-findings.md");
note("set STRICT_BUGS=1 to make the suite exit non-zero while any known bug is open");
const exitCode = await harness.run();
process.exitCode = exitCode;
