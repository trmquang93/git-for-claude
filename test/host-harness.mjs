/**
 * Shared plumbing for the Host-side test suite.
 *
 * Everything here is deliberately independent from `index.js`: git expectations
 * are derived with the `git` CLI (`node:child_process`), fixtures are throwaway
 * mkdtemp repositories, and every helper cleans up after itself in `finally`.
 *
 * Used by `test/host-suite.mjs`; tests never import this file's internals from
 * the product modules except the public exports of `../index.js`.
 */
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Every fixture directory starts with this prefix, so leftovers are obvious. */
export const FIXTURE_PREFIX = "git-for-claude-suite-";

/** Run a child process without a shell and collect its output. */
export function runProcess(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: options.cwd,
    input: options.input,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    env: options.env ?? process.env,
  });
  return {
    code: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Run git, returning the raw result (non-zero exit is not an error). */
export function gitTry(dir, args, options = {}) {
  return runProcess("git", args, { cwd: dir, input: options.input, env: options.env });
}

/** Run git and throw on a non-zero exit, returning trimmed stdout. */
export function git(dir, ...args) {
  const result = gitTry(dir, args);
  if (result.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${String(result.code)}): ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
    );
  }
  return result.stdout.trim();
}

/** Subject line captured for the final report, not a test failure. */
export function firstLine(text, limit = 500) {
  const value = String(text ?? "").trim();
  const line = value.split("\n")[0] ?? "";
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

/**
 * Create an isolated repository fixture.
 *
 * `files` maps repository-relative paths to initial committed content.
 * Returns convenience accessors so tests read like prose.
 */
export function makeRepo(files = {}, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), FIXTURE_PREFIX));
  const repo = {
    dir,
    real: realpathSync(dir),
    path(rel) {
      return join(dir, rel);
    },
    write(rel, content) {
      const absolute = join(dir, rel);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, content);
      return absolute;
    },
    remove(rel) {
      rmSync(join(dir, rel), { force: true });
    },
    read(rel) {
      return readFileSync(join(dir, rel), "utf8");
    },
    readBuffer(rel) {
      return readFileSync(join(dir, rel));
    },
    exists(rel) {
      return existsSync(join(dir, rel));
    },
    git(...args) {
      return git(dir, ...args);
    },
    tryGit(...args) {
      return gitTry(dir, args);
    },
    apiDir: dir,
  };
  git(dir, "init", "-q", "-b", options.branch ?? "main");
  git(dir, "config", "user.email", options.email ?? "test@example.com");
  git(dir, "config", "user.name", options.name ?? "Test User");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "advice.detachedHead", "false");
  for (const [rel, content] of Object.entries(files)) repo.write(rel, content);
  if (options.initialCommit !== false && Object.keys(files).length > 0) {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", options.message ?? "initial");
  }
  return repo;
}

/** Run a test body against one isolated repository, always cleaning up. */
export async function withRepo(files, fn, options = {}) {
  const repo = makeRepo(files, options);
  try {
    return await fn(repo);
  } finally {
    rmSync(repo.dir, { recursive: true, force: true });
  }
}

/** Run a test body against a throwaway directory that is not a repository. */
export async function withPlainDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), `${FIXTURE_PREFIX}plain-`));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Create a throwaway directory the body may turn into a remote/repo. */
export function makeTempDir(prefix = `${FIXTURE_PREFIX}tmp-`) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Remove a fixture directory created by makeTempDir / mkdtempSync. */
export function removeTempDir(dir) {
  if (typeof dir === "string" && dir !== "") rmSync(dir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ *
 * Patch helpers: the suite selects raw body-line indexes exactly like
 * the browser half does (`lines` are 0-based indexes of the displayed
 * diff, which is `patchText.split("\n")`).
 * ------------------------------------------------------------------ */

/** Split a patch into raw lines (indexes are what `lines` refers to). */
export function patchLines(patch) {
  return String(patch ?? "").split("\n");
}

/** Raw indexes of body lines matching `predicate`. */
export function select(patch, predicate) {
  const selected = [];
  patchLines(patch).forEach((line, index) => {
    if (predicate(line, index)) selected.push(index);
  });
  return selected;
}

/** Indexes of added (`+`) and removed (`-`) body lines, not file headers. */
export function selectChanges(patch) {
  return select(patch, (line) => (line.startsWith("+") && !line.startsWith("+++")) || (line.startsWith("-") && !line.startsWith("---")));
}

/** Indexes of added body lines only. */
export function selectAdded(patch) {
  return select(patch, (line) => line.startsWith("+") && !line.startsWith("+++"));
}

/** Indexes of removed body lines only. */
export function selectRemoved(patch) {
  return select(patch, (line) => line.startsWith("-") && !line.startsWith("---"));
}

/** All `@@` hunk header lines of a patch. */
export function hunkHeaders(patch) {
  return patchLines(patch).filter((line) => line.startsWith("@@ "));
}

/**
 * Body lines (` `, `+`, `-`, `\`) of every hunk, in order. File headers such
 * as `--- a/f` / `+++ b/f` are not body lines and are excluded.
 */
export function patchBodyLines(patch) {
  const body = [];
  let inHunk = false;
  for (const line of patchLines(patch)) {
    if (line.startsWith("@@ ")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith("\\")) {
      body.push(line);
    }
  }
  return body;
}

/**
 * Apply a single-file patch to the index with `git apply --cached`.
 * Returns the raw git result instead of throwing so known-bug tests can
 * report the exact git diagnostic.
 */
export function applyPatchToIndex(dir, patchText, options = {}) {
  const args = ["apply", "--cached", "--whitespace=nowarn"];
  if (options.reverse === true) args.push("--reverse");
  if (options.allowEmpty === true) args.push("--allow-empty");
  args.push("-");
  return gitTry(dir, args, { input: patchText });
}

/** Content of one path in the index (`:path`), or null when absent. */
export function indexContent(dir, rel) {
  const result = gitTry(dir, ["show", `:${rel}`]);
  return result.code === 0 ? result.stdout : null;
}

/** Repository-relative paths present in the index. */
export function indexPaths(dir) {
  return gitTry(dir, ["diff", "--cached", "--name-only", "-z"]).stdout.split("\0").filter(Boolean);
}

/** Read a worktree file as text. */
export function fileText(dir, rel) {
  return readFileSync(join(dir, rel), "utf8");
}

/** `git status --porcelain` (v1) lines; handy independent expectation. */
export function statusV1(dir) {
  const result = gitTry(dir, ["status", "--porcelain"]);
  if (result.code !== 0) {
    throw new Error(`git status --porcelain failed (${String(result.code)}): ${result.stderr.trim()}`);
  }
  // Do not trim: the two status columns (and therefore leading spaces) matter.
  return result.stdout.split("\n").filter((line) => line !== "");
}

/**
 * The exact `git diff` invocation `api.diff` should be equivalent to,
 * used to derive expected patches independently.
 */
export function cliDiff(dir, rel, options = {}) {
  const args = ["--no-pager", "diff", "--no-color", "--no-ext-diff"];
  if (options.noRenames !== false) args.push("--no-renames");
  args.push(`-U${String(options.context ?? 3)}`);
  if (options.staged === true) args.push("--cached");
  args.push("--", rel);
  const result = gitTry(dir, args);
  if (result.code !== 0) {
    throw new Error(`git diff for ${rel} failed (${String(result.code)}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** The exact untracked (`--no-index /dev/null`) diff for a repo-relative path. */
export function cliUntrackedDiff(dir, rel, options = {}) {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  // A relative path keeps the patch headers repo-relative.
  const result = gitTry(dir, [
    "--no-pager",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-index",
    `-U${String(options.context ?? 3)}`,
    "--",
    nullDevice,
    rel,
  ]);
  if (result.code !== 0 && result.code !== 1) {
    throw new Error(`git diff --no-index for ${rel} failed (${String(result.code)}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Every "Binary files … differ" line in a patch. */
export function binaryMarkers(patch) {
  return patchLines(patch).filter((line) => line.startsWith("Binary files "));
}

/* ------------------------------------------------------------------ *
 * Minimal test registry: pass / fail / known-bug / skip accounting.
 * A known-bug test asserts the *correct* behaviour; while the product
 * bug exists it fails and is recorded (not counted as a suite failure).
 * If it unexpectedly passes, the suite flags it so the finding can be
 * retired.
 * ------------------------------------------------------------------ */

export function createHarness() {
  const entries = [];
  const results = {
    passed: 0,
    failed: 0,
    knownBugs: [],
    skipped: [],
    durationMs: 0,
  };
  const failures = [];
  const notes = [];

  function test(name, fn) {
    entries.push({ kind: "test", name, fn });
  }

  function knownBug(id, name, fn) {
    entries.push({ kind: "known-bug", id, name, fn });
  }

  function skip(name, reason) {
    entries.push({ kind: "skip", name, reason });
  }

  function note(text) {
    notes.push(text);
  }

  function areaOf(name) {
    const slash = name.indexOf("/");
    return slash === -1 ? "general" : name.slice(0, slash);
  }

  function shortError(error) {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 1200 ? `${message.slice(0, 1200)}…` : message;
  }

  async function run() {
    const started = Date.now();
    let currentArea = "";
    console.log("git-for-claude Host test suite");
    console.log("=======================");
    for (const entry of entries) {
      const area = areaOf(entry.name);
      if (area !== currentArea) {
        console.log(`\n── ${area} ──`);
        currentArea = area;
      }
      if (entry.kind === "skip") {
        results.skipped.push({ name: entry.name, reason: entry.reason });
        console.log(`  SKIP  ${entry.name} — ${entry.reason}`);
        continue;
      }
      const testStarted = Date.now();
      try {
        await entry.fn();
        const elapsed = Date.now() - testStarted;
        if (entry.kind === "known-bug") {
          results.failed += 1;
          const error = new Error(
            `known bug ${entry.id} no longer reproduces (test passed) — update test/host-findings.md and remove the knownBug wrapper`,
          );
          failures.push({ name: entry.name, error });
          console.log(`  XPASS ${entry.id}  ${entry.name} (${String(elapsed)}ms)`);
          console.log("        expected this test to fail while the bug exists");
        } else {
          results.passed += 1;
          console.log(`  PASS  ${entry.name} (${String(elapsed)}ms)`);
        }
      } catch (error) {
        const elapsed = Date.now() - testStarted;
        if (entry.kind === "known-bug") {
          results.knownBugs.push({ id: entry.id, name: entry.name, message: shortError(error) });
          console.log(`  KNOWN ${entry.id}  ${entry.name} (${String(elapsed)}ms)`);
          console.log(`        ${firstLine(shortError(error))}`);
        } else {
          results.failed += 1;
          failures.push({ name: entry.name, error });
          console.log(`  FAIL  ${entry.name} (${String(elapsed)}ms)`);
          console.log(
            shortError(error)
              .split("\n")
              .map((line) => `        ${line}`)
              .join("\n"),
          );
        }
      }
    }
    results.durationMs = Date.now() - started;

    console.log("\n=======================");
    const total = results.passed + results.failed + results.knownBugs.length + results.skipped.length;
    console.log(
      `SUMMARY: ${String(total)} tests — ${String(results.passed)} passed, ${String(results.failed)} failed, ` +
        `${String(results.knownBugs.length)} known-bug, ${String(results.skipped.length)} skipped`,
    );
    console.log(`duration: ${String((results.durationMs / 1000).toFixed(1))}s`);
    if (results.durationMs > 90_000) {
      console.log("WARNING: suite exceeded the ~90s budget");
    }
    for (const entry of results.knownBugs) {
      console.log(`  KNOWN ${entry.id}: ${entry.name}`);
    }
    for (const noteText of notes) console.log(`  note: ${noteText}`);
    if (failures.length > 0) {
      console.log("\nFAILURES:");
      for (const failure of failures) {
        console.log(`  - ${failure.name}`);
        console.log(
          shortError(failure.error)
            .split("\n")
            .map((line) => `      ${line}`)
            .join("\n"),
        );
      }
      console.log("\nRESULT: FAIL");
      return 1;
    }
    if (process.env.STRICT_BUGS === "1" && results.knownBugs.length > 0) {
      console.log(`\nRESULT: FAIL (STRICT_BUGS=1, ${String(results.knownBugs.length)} known product bug(s) open)`);
      return 2;
    }
    console.log(
      `\nRESULT: PASS (every non-known-bug test passed; ${String(results.knownBugs.length)} known product bug(s) documented in test/host-findings.md)`,
    );
    return 0;
  }

  return { test, knownBug, skip, note, run, results, failures, entries };
}
