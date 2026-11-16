// @ts-nocheck
/**
 * Git engine ported from @local/dsh-git index.js. Pure: all process and file
 * access goes through the injected `io` ({ run, fileSize, readBase64, warn }).
 */

/** Package name reported to the Typert Gateway. */
const PACKAGE_NAME = "@local/dsh-git";

/** Service key and Remote namespace exposed to the Typert Gateway. */
const SERVICE_KEY = "gitIntegration";
const NAMESPACE = "git";

/** src-json codec: lossless JSON values pass through unchanged. */
const JSON_CODEC = { mode: "src-json" };

/** Local commands finish well inside this; network commands get the long one. */
const DEFAULT_TIMEOUT_MS = 20_000;
const NETWORK_TIMEOUT_MS = 180_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** Images above this size are reported but not inlined as data URLs. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** Extension → MIME for the image preview. */
const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  svg: "image/svg+xml",
};

/** MIME type of a repository path when the panel can preview it. */
function imageMime(path) {
  const name = String(path ?? "");
  const dot = name.lastIndexOf(".");
  if (dot === -1) return null;
  return IMAGE_MIME[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** Reject paths that could escape the repository or name an option. */
function repoRelativePath(value, method) {
  if (typeof value !== "string") throw new Error(`git/${method}: a path is required`);
  const path = value.trim();
  if (path === "") throw new Error(`git/${method}: a path is required`);
  if (path.startsWith("-")) throw new Error(`git/${method}: a path cannot start with "-"`);
  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path)) throw new Error(`git/${method}: a repository-relative path is required`);
  if (path.split(/[\\/]/u).includes("..")) throw new Error(`git/${method}: a path cannot leave the repository`);
  return path;
}

/**
 * Clear inherited repository selectors so a git run never escapes the cwd it
 * was given (the same hygiene the shipped worktree service applies).
 */
/** Repository selectors cleared with `env -u` (process.run can set env, not unset it). */
const UNSET_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_CEILING_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  "GIT_REPLACE_REF_BASE",
  "GIT_ATTR_SOURCE",
];
const GIT_ENV = {};

/** One field of a Remote method: the browser sends `{ wire: value }`. */
function field(name, description) {
  return { name, wire: name, description, source: "json", codec: JSON_CODEC };
}

/** Trim a subprocess diagnostic to something a panel can render. */
function tail(text, limit = 8000) {
  const value = typeof text === "string" ? text.trim() : "";
  return value.length > limit ? `…${value.slice(-limit)}` : value;
}

/** Coerce a value to a positive integer within a range. */
function positiveInt(value, fallback, max) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded <= 0) return fallback;
  return max === undefined ? rounded : Math.min(rounded, max);
}

/**
 * Normalize a worktree path argument. Leading "-" is rejected because the
 * value is passed straight to argv (no shell, but option injection is still
 * possible), and every command spells the path after "--" anyway.
 */
function worktreePath(value, method) {
  if (typeof value !== "string") throw new Error(`git/${method}: a worktree path is required`);
  const path = value.trim();
  if (path === "") throw new Error(`git/${method}: a worktree path is required`);
  if (path.startsWith("-")) throw new Error(`git/${method}: a worktree path cannot start with "-"`);
  return path;
}

/** Normalize an optional branch name / revision argument for argv. */
function revisionArg(value, method, label) {
  if (typeof value !== "string") return undefined;
  const ref = value.trim();
  if (ref === "") return undefined;
  if (ref.startsWith("-")) throw new Error(`git/${method}: ${label} cannot start with "-"`);
  return ref;
}

/** Compare two worktree paths the way the platform does. */
function samePath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const normalize = (value) => {
    const trimmed = value.replace(/[\\/]+$/u, "");
    return trimmed;
  };
  return normalize(left) === normalize(right);
}

/** Normalize the `paths` wire field to an array of non-empty strings. */
function pathList(paths) {
  if (!Array.isArray(paths)) return [];
  const seen = new Set();
  const rows = [];
  for (const entry of paths) {
    if (typeof entry !== "string" || entry === "") continue;
    if (seen.has(entry)) continue;
    seen.add(entry);
    rows.push(entry);
  }
  return rows;
}

/**
 * Parse `git status --porcelain=v2 --branch -z` into branch facts and rows.
 * @param raw - NUL-separated porcelain v2 output.
 * @returns `{ branch, files }` with one row per path.
 */
export function parsePorcelainV2(raw) {
  const tokens = String(raw ?? "").split("\0");
  const branch = {
    oid: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
  };
  const files = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "") continue;
    if (token.startsWith("# ")) {
      const body = token.slice(2);
      const space = body.indexOf(" ");
      const key = space === -1 ? body : body.slice(0, space);
      const value = space === -1 ? "" : body.slice(space + 1);
      if (key === "branch.oid") branch.oid = value;
      else if (key === "branch.head") branch.head = value;
      else if (key === "branch.upstream") branch.upstream = value;
      else if (key === "branch.ab") {
        const match = /^\+(\d+) -(\d+)$/u.exec(value);
        if (match !== null) {
          branch.ahead = Number(match[1]);
          branch.behind = Number(match[2]);
        }
      }
      continue;
    }
    const kind = token[0];
    if (kind === "1") {
      const parts = token.split(" ");
      files.push({
        path: parts.slice(8).join(" "),
        x: parts[1]?.[0] ?? ".",
        y: parts[1]?.[1] ?? ".",
        kind: "tracked",
      });
    } else if (kind === "2") {
      const parts = token.split(" ");
      const path = parts.slice(9).join(" ");
      // In -z mode a rename entry is followed by its original path token.
      const original = tokens[index + 1];
      if (typeof original === "string") index += 1;
      files.push({
        path,
        origPath: original ?? null,
        x: parts[1]?.[0] ?? ".",
        y: parts[1]?.[1] ?? ".",
        kind: "rename",
      });
    } else if (kind === "u") {
      const parts = token.split(" ");
      files.push({
        path: parts.slice(10).join(" "),
        x: parts[1]?.[0] ?? "U",
        y: parts[1]?.[1] ?? "U",
        kind: "unmerged",
      });
    } else if (kind === "?") {
      files.push({ path: token.slice(2), x: "?", y: "?", kind: "untracked" });
    } else if (kind === "!") {
      // Ignored paths are not part of the panel's model.
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { branch, files };
}

/**
 * Build a minimal unified patch that keeps only the selected body lines.
 *
 * Used for staging or unstaging part of one file. File headers (everything
 * before the first hunk) are preserved, hunk headers are recomputed from the
 * kept body lines, and every context line is kept so the patch applies to the
 * exact file the browser displayed.
 *
 * @param patchText - one complete `git diff` for a single path.
 * @param selected - raw line indexes (0-based, within `patchText`) to keep.
 * @returns patch text ready for `git apply`, or "" when nothing is selected.
 */
export function buildPartialPatch(patchText, selected, reverse = false) {
  const keep = selected instanceof Set ? selected : new Set(selected ?? []);
  const lines = String(patchText ?? "").split("\n");
  let index = 0;
  const preamble = [];
  while (index < lines.length && !lines[index].startsWith("@@ ")) {
    preamble.push(lines[index]);
    index += 1;
  }
  if (index >= lines.length) return "";

  const hunks = [];
  while (index < lines.length) {
    const header = lines[index];
    if (!header.startsWith("@@ ")) {
      index += 1;
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/u.exec(header);
    if (match === null) {
      index += 1;
      continue;
    }
    const hunk = {
      oldStart: Number(match[1]),
      newStart: Number(match[3]),
      section: match[5] ?? "",
      body: [],
      indexes: [],
    };
    index += 1;
    while (index < lines.length && !lines[index].startsWith("@@ ")) {
      const bodyLine = lines[index];
      if (bodyLine === "" && index === lines.length - 1) break;
      hunk.body.push(bodyLine);
      hunk.indexes.push(index);
      index += 1;
    }
    hunks.push(hunk);
  }

  // Which changed body lines did the caller select?
  const changed = [];
  for (const hunk of hunks) {
    for (let position = 0; position < hunk.body.length; position += 1) {
      const marker = hunk.body[position][0];
      if (marker === "+" || marker === "-") changed.push(hunk.indexes[position]);
    }
  }
  const selectedChanged = changed.filter((raw) => keep.has(raw));
  if (selectedChanged.length === 0) return "";
  const complete = selectedChanged.length === changed.length;

  const oldSideIsNull = preamble.some((line) => line.startsWith("--- /dev/null"));
  const newSideIsNull = preamble.some((line) => line.startsWith("+++ /dev/null"));
  // A partial selection of a whole-file addition/deletion needs the /dev/null
  // header rewritten on the side that git will match against the index:
  // forward staging matches the old side, reverse unstaging matches the new side.
  const rewriteOldSide = reverse && oldSideIsNull && !complete;
  const rewriteNewSide = !reverse && newSideIsNull && !complete;
  // Restoring only part of a staged whole-file deletion cannot be represented:
  // the index no longer holds the file, so there is no side to match.
  if (reverse && newSideIsNull && !complete) return "";

  const diffLine = preamble.find((line) => line.startsWith("diff --git ")) ?? "";
  const pathMatch = /^diff --git a\/(.+) b\/(.+)$/u.exec(diffLine);
  const path = pathMatch === null ? null : pathMatch[2];

  const out = [];
  for (const line of preamble) {
    if (rewriteOldSide) {
      if (line.startsWith("new file mode ") || line.startsWith("index ")) continue;
      if (line === "--- /dev/null" && path !== null) {
        out.push(`--- a/${path}`);
        continue;
      }
    }
    if (rewriteNewSide) {
      if (line.startsWith("deleted file mode ") || line.startsWith("index ")) continue;
      if (line === "+++ /dev/null" && path !== null) {
        out.push(`+++ b/${path}`);
        continue;
      }
    }
    out.push(line);
  }

  let keptHunks = 0;
  for (const hunk of hunks) {
    const hasMarker = hunk.body.some((line) => line[0] === "\\");
    let changedInHunk = 0;
    let selectedInHunk = 0;
    for (let position = 0; position < hunk.body.length; position += 1) {
      const marker = hunk.body[position][0];
      if (marker !== "+" && marker !== "-") continue;
      changedInHunk += 1;
      if (keep.has(hunk.indexes[position])) selectedInHunk += 1;
    }
    if (selectedInHunk === 0) continue;
    // The "\ No newline at end of file" marker belongs to the body line before
    // it; a partial selection inside such a hunk cannot be represented without
    // contradicting that line, so leave the hunk alone.
    if (hasMarker && selectedInHunk !== changedInHunk) continue;

    const emitted = [];
    let oldCount = 0;
    let newCount = 0;
    let changes = 0;
    let lastKeptRaw = -1;
    for (let position = 0; position < hunk.body.length; position += 1) {
      const bodyLine = hunk.body[position];
      const raw = hunk.indexes[position];
      const marker = bodyLine[0];
      const text = bodyLine.slice(1);
      if (marker === " ") {
        emitted.push(bodyLine);
        oldCount += 1;
        newCount += 1;
        lastKeptRaw = raw;
      } else if (marker === "+") {
        if (keep.has(raw)) {
          emitted.push(bodyLine);
          newCount += 1;
          changes += 1;
          lastKeptRaw = raw;
        } else if (reverse) {
          // The addition stays in the index, so the reverse patch must see it.
          emitted.push(` ${text}`);
          oldCount += 1;
          newCount += 1;
          lastKeptRaw = raw;
        }
      } else if (marker === "-") {
        if (keep.has(raw)) {
          emitted.push(bodyLine);
          oldCount += 1;
          changes += 1;
          lastKeptRaw = raw;
        } else if (!reverse) {
          // The deletion stays in the index, so the forward patch must keep it.
          emitted.push(` ${text}`);
          oldCount += 1;
          newCount += 1;
          lastKeptRaw = raw;
        }
      } else if (marker === "\\") {
        if (raw === lastKeptRaw + 1) emitted.push(bodyLine);
      }
    }
    if (changes === 0) continue;
    let oldStart = hunk.oldStart;
    let newStart = hunk.newStart;
    // A rewritten add/delete header turns a zero start into a present file.
    if (oldStart === 0 && oldCount > 0) oldStart = 1;
    if (newStart === 0 && newCount > 0) newStart = 1;
    const section = hunk.section === "" ? "" : ` ${hunk.section}`;
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${section}`);
    out.push(...emitted);
    keptHunks += 1;
  }
  if (keptHunks === 0) return "";
  return `${out.join("\n")}\n`;
}

/** Split a `%x1f`-separated git format line into trimmed fields. */
function splitFields(line, separator) {
  return line.split(separator ?? "\u001f");
}

/**
 * Build the Host service object.
 * @param ctx - Cordis context carrying `subprocess`.
 * @returns the published `gitIntegration` service.
 */
export function createApi(io) {

  /** True when git's output describes a real merge/pick conflict. */
  function looksLikeConflict(result) {
    const text = `${result.stdout}\n${result.stderr}`;
    return /CONFLICT|Automatic merge failed|Resolve all conflicts|could not apply|needs merge|fix conflicts|Merge conflict in/iu.test(text);
  }

  /** Build a conflict outcome, or throw for ref/config failures that only exit non-zero. */
  function conflictOrThrow(label, result) {
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    if (result.code === 0) return { ok: true, conflicts: false, stdout, stderr };
    if (!looksLikeConflict(result)) {
      throw new Error(`git ${label} failed: ${tail(result.stderr) || tail(result.stdout) || "unknown failure"}`);
    }
    return { ok: false, conflicts: true, stdout, stderr };
  }

  /** Report a contained internal failure without breaking the panel. */
  function warn(message) {
    try {
      io.warn?.(`git-for-claude: ${message}`);
    } catch {
      // A logger fault must never fail a git operation.
    }
  }

  async function execGit(dir, argv, options = {}) {
    const { stdin, allowCodes = [0], timeoutMs = DEFAULT_TIMEOUT_MS, env } = options;
    if (typeof dir !== "string" || dir.trim() === "") {
      throw new Error("git: a repository directory is required");
    }
    // `env -u` clears the repository selectors that process.run cannot unset.
    const unset = UNSET_ENV.flatMap((key) => ["-u", key]);
    const result = await io.run(["env", ...unset, "git", ...argv], {
      cwd: dir,
      env: {
        ...GIT_ENV,
        GIT_TERMINAL_PROMPT: "0",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_PAGER: "cat",
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
        ...(env ?? {}),
      },
      stdin,
      timeoutMs,
    });
    const lossy = Boolean(result.isStdoutTruncated || result.isStderrTruncated);
    if (!allowCodes.includes(result.exitCode)) {
      const detail = tail(result.stderr) || tail(result.stdout) || "no output";
      throw new Error(`git ${argv.join(" ")} failed (${String(result.exitCode)}): ${detail}`);
    }
    return { code: result.exitCode, signal: null, stdout: result.stdout, stderr: result.stderr, lossy };
  }

  /**
   * Resolve the repository toplevel for a directory.
   * @param dir - any directory inside the repository.
   * @returns the absolute toplevel path.
   */
  async function repoRoot(dir) {
    const result = await execGit(dir, ["rev-parse", "--show-toplevel"]);
    const root = result.stdout.trim();
    if (root === "") throw new Error(`git: "${dir}" is not a git repository`);
    return root;
  }

  /** Run one git argv inside the repository containing `dir`. */
  async function repoGit(dir, argv, options) {
    const root = await repoRoot(dir);
    return { root, result: await execGit(root, argv, options) };
  }

  /**
   * Read the complete state the panel renders: branch facts, porcelain rows,
   * and in-progress operation markers.
   * @param dir - repository directory.
   * @returns the status payload, or `{ isRepo: false, error }`.
   */
  async function status(request) {
    const dir = request?.dir;
    let root;
    try {
      root = await repoRoot(dir);
    } catch (error) {
      return {
        dir,
        isRepo: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const [porcelain, mergeHead, rebaseHead, cherryHead, revertHead] = await Promise.all([
      execGit(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], {
        timeoutMs: 30_000,
      }),
      execGit(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowCodes: [0, 1] }),
      execGit(root, ["rev-parse", "-q", "--verify", "REBASE_HEAD"], { allowCodes: [0, 1] }),
      execGit(root, ["rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"], { allowCodes: [0, 1] }),
      execGit(root, ["rev-parse", "-q", "--verify", "REVERT_HEAD"], { allowCodes: [0, 1] }),
    ]);
    const { branch, files } = parsePorcelainV2(porcelain.stdout);
    const detached = branch.head === "(detached)" || branch.head === null;
    const initial = branch.oid === "(initial)";
    return {
      dir,
      root,
      isRepo: true,
      branch: {
        name: detached ? null : branch.head,
        detached: detached && !initial,
        initial,
        oid: initial ? null : branch.oid,
        shortOid: initial || branch.oid === null ? null : branch.oid.slice(0, 7),
        upstream: branch.upstream,
        ahead: branch.ahead,
        behind: branch.behind,
      },
      files,
      counts: {
        staged: files.filter((file) => file.kind !== "untracked" && file.x !== ".").length,
        unstaged: files.filter((file) => file.kind === "untracked" || file.y !== ".").length,
        untracked: files.filter((file) => file.kind === "untracked").length,
        conflicts: files.filter((file) => file.kind === "unmerged").length,
      },
      inProgress: {
        merge: mergeHead.code === 0,
        rebase: rebaseHead.code === 0,
        cherryPick: cherryHead.code === 0,
        revert: revertHead.code === 0,
      },
    };
  }

  /**
   * Read one file's diff.
   * @param request - `{ dir, path, staged, untracked, context }`.
   * @returns `{ root, path, staged, patch, empty, binary }`.
   */
  async function diff(request) {
    const dir = request?.dir;
    const path = request?.path;
    if (typeof path !== "string" || path === "") throw new Error("git/diff: a path is required");
    const root = await repoRoot(dir);
    const rawContext = request?.context;
    const context =
      rawContext === 0 || rawContext === "0" ? 0 : Math.min(positiveInt(rawContext, 3, 40), 40);
    if (request?.untracked === true) {
      const relative = path.replace(/^\.\//u, "");
      const nullDevice = "/dev/null";
      // A repo-relative path from the repository root yields repo-relative
      // headers; absolute paths leak the temp path into the patch and would
      // stage a bogus path when fed back to `git apply`.
      const result = await execGit(root, ["--no-pager", "diff", "--no-color", "--no-ext-diff", "--no-index", `-U${String(context)}`, "--", nullDevice, relative], {
        allowCodes: [0, 1],
        maxBytes: 2 * 1024 * 1024,
        timeoutMs: 90_000,
      });
      return {
        root,
        path,
        staged: false,
        untracked: true,
        patch: result.stdout,
        empty: result.stdout.trim() === "",
        binary: /^Binary files /mu.test(result.stdout),
      };
    }
    const argv = ["--no-pager", "diff", "--no-color", "--no-ext-diff", "--no-renames", `-U${String(context)}`];
    if (request?.staged === true) argv.push("--cached");
    argv.push("--", path);
    const result = await execGit(root, argv, { maxBytes: 2 * 1024 * 1024, timeoutMs: 90_000 });
    return {
      root,
      path,
      staged: request?.staged === true,
      untracked: false,
      patch: result.stdout,
      empty: result.stdout.trim() === "",
      binary: /^Binary files /mu.test(result.stdout),
    };
  }

  /** One side of an image comparison as base64 (worktree file, index blob or revision blob). */
  async function readImageSide(root, source, repoPath) {
    const read = async (file) => {
      const size = await io.fileSize(file);
      if (size === null) return null;
      if (size > MAX_IMAGE_BYTES) return { tooLarge: true, bytes: size };
      return { bytes: size, base64: await io.readBase64(file) };
    };
    if (source === "worktree") {
      try {
        return await read(`${root}/${repoPath}`);
      } catch {
        return null;
      }
    }
    let dir = "";
    try {
      dir = (await io.run(["mktemp", "-d"])).stdout.trim();
      if (dir === "") return null;
      const prefix = `${dir}/`;
      if (source === "index") {
        await execGit(root, ["checkout-index", `--prefix=${prefix}`, "--", repoPath]);
      } else {
        const indexFile = `${dir}/index`;
        await execGit(root, ["read-tree", source], { env: { GIT_INDEX_FILE: indexFile } });
        await execGit(root, ["checkout-index", `--prefix=${prefix}`, "--", repoPath], { env: { GIT_INDEX_FILE: indexFile } });
      }
      return await read(`${dir}/${repoPath}`);
    } catch {
      return null;
    } finally {
      if (dir !== "") await io.run(["rm", "-rf", dir]).catch(() => {});
    }
  }

  /** Read both sides of an image comparison as data URLs. */
  async function image(request) {
    const root = await repoRoot(request?.dir);
    const repoPath = repoRelativePath(request?.path, "image");
    const mime = imageMime(repoPath);
    if (mime === null) throw new Error("git/image: the path is not a previewable image");
    const staged = request?.staged === true;
    const untracked = request?.untracked === true;
    const beforeSource = untracked ? null : staged ? "HEAD" : "index";
    const afterSource = untracked ? "worktree" : staged ? "index" : "worktree";
    const [before, after] = await Promise.all([
      beforeSource === null ? Promise.resolve(null) : readImageSide(root, beforeSource, repoPath),
      afterSource === null ? Promise.resolve(null) : readImageSide(root, afterSource, repoPath),
    ]);
    const encode = (side) =>
      side === null
        ? null
        : side.tooLarge === true
          ? { tooLarge: true, bytes: side.bytes }
          : { bytes: side.bytes, dataUrl: `data:${mime};base64,${side.base64}` };
    return { root, path: repoPath, mime, before: encode(before), after: encode(after) };
  }

  /** Stage paths (or everything) in the index. */
  async function stage(request) {
    const root = await repoRoot(request?.dir);
    const paths = pathList(request?.paths);
    const argv = ["add", "-A"];
    if (paths.length > 0) argv.push("--", ...paths);
    await execGit(root, argv);
    return { ok: true };
  }

  /** Unstage paths (or everything) from the index. */
  async function unstage(request) {
    const root = await repoRoot(request?.dir);
    const paths = pathList(request?.paths);
    if (paths.length === 0) {
      const head = await execGit(root, ["rev-parse", "-q", "--verify", "HEAD"], { allowCodes: [0, 1] });
      if (head.code === 0) {
        await execGit(root, ["reset", "-q", "HEAD"]);
      } else {
        await execGit(root, ["rm", "-r", "--cached", "--quiet", "--", "."]);
      }
      return { ok: true };
    }
    try {
      await execGit(root, ["restore", "--staged", "--", ...paths]);
    } catch (error) {
      // `restore` is absent before git 2.23 and cannot resolve an unborn HEAD.
      warn(`restore --staged failed, falling back to rm --cached: ${error instanceof Error ? error.message : String(error)}`);
      await execGit(root, ["rm", "--cached", "-r", "--quiet", "--", ...paths]);
    }
    return { ok: true };
  }

  /**
   * Discard changes for paths, mirroring lazygit's behaviour.
   * @param request - `{ dir, paths, untracked, keepStaged }`.
   */
  async function discard(request) {
    const root = await repoRoot(request?.dir);
    const paths = pathList(request?.paths);
    if (paths.length === 0) throw new Error("git/discard: at least one path is required");
    if (request?.untracked === true) {
      await execGit(root, ["clean", "-f", "-d", "--", ...paths]);
      return { ok: true };
    }
    if (request?.keepStaged !== true) {
      await execGit(root, ["restore", "--staged", "--", ...paths], { allowCodes: [0] }).catch(async () => {
        await execGit(root, ["rm", "--cached", "-r", "--quiet", "--", ...paths]);
      });
    }
    for (const path of paths) {
      const tracked = await execGit(root, ["ls-files", "--error-unmatch", "--", path], { allowCodes: [0, 1] });
      if (tracked.code === 0) {
        await execGit(root, ["checkout", "--", path]);
      } else {
        await execGit(root, ["clean", "-f", "-d", "--", path]);
      }
    }
    return { ok: true };
  }

  /**
   * Apply a partial patch built from selected diff lines.
   * @param request - `{ dir, path, staged, patch, lines }`.
   */
  async function stageLines(request) {
    const patch = typeof request?.patch === "string" ? request.patch : "";
    const lines = Array.isArray(request?.lines) ? request.lines.map((value) => Number(value)) : [];
    if (patch === "") throw new Error("git/stageLines: the displayed diff is required");
    const reverse = request?.staged === true;
    const partial = buildPartialPatch(patch, lines, reverse);
    if (partial === "") throw new Error("git/stageLines: no lines were selected");
    const root = await repoRoot(request?.dir);
    const argv = ["apply", "--cached", "--whitespace=nowarn"];
    if (request?.staged === true) argv.push("--reverse");
    await execGit(root, argv, { stdin: partial });
    return { ok: true };
  }

  /** Create a commit from the index, optionally amending. */
  async function commit(request) {
    const root = await repoRoot(request?.dir);
    const message = typeof request?.message === "string" ? request.message : "";
    const amend = request?.amend === true;
    const argv = ["commit"];
    if (amend) argv.push("--amend");
    if (message.trim() === "") {
      if (!amend) throw new Error("git/commit: a commit message is required");
      argv.push("--no-edit");
    } else {
      argv.push("-F", "-");
    }
    if (request?.allowEmpty === true) argv.push("--allow-empty");
    if (request?.signoff === true) argv.push("-s");
    if (request?.noVerify === true) argv.push("--no-verify");
    const result = await execGit(root, argv, { stdin: message.trim() === "" ? undefined : message });
    const head = await execGit(root, ["log", "-1", "--pretty=format:%h%x1f%s"]);
    const [shortHash, subject] = splitFields(head.stdout.trim());
    return { ok: true, hash: shortHash ?? null, subject: subject ?? null, output: result.stdout.trim() };
  }

  /** Read the last commit message (used to prefill an amend). */
  async function lastCommitMessage(request) {
    const { result } = await repoGit(request?.dir, ["log", "-1", "--pretty=format:%B"], { allowCodes: [0, 1] });
    return { message: result.code === 0 ? result.stdout.replace(/\n$/u, "") : "" };
  }

  /** List local and remote branches with their tips. */
  async function branches(request) {
    const root = await repoRoot(request?.dir);
    const format = [
      "%(refname:short)",
      "%(refname)",
      "%(upstream:short)",
      "%(objectname:short)",
      "%(committerdate:relative)",
      "%(HEAD)",
      "%(symref)",
      "%(subject)",
    ].join("%01");
    const result = await execGit(root, ["for-each-ref", `--format=${format}`, "refs/heads", "refs/remotes"]);
    const local = [];
    const remote = [];
    for (const line of result.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const [name, refname, upstream, tip, date, head, symref, subject] = splitFields(line, "\u0001");
      if (symref !== undefined && symref !== "") continue;
      if (refname?.startsWith("refs/heads/") === true) {
        local.push({
          name,
          tip,
          date,
          current: head === "*",
          upstream: upstream ?? "",
          subject: subject ?? "",
        });
      } else if (refname?.startsWith("refs/remotes/") === true) {
        const slash = (name ?? "").indexOf("/");
        remote.push({
          name,
          remote: slash === -1 ? "" : (name ?? "").slice(0, slash),
          branch: slash === -1 ? (name ?? "") : (name ?? "").slice(slash + 1),
          tip,
          date,
          subject: subject ?? "",
        });
      }
    }
    return { local, remote };
  }

  /** Check out a branch, remote branch, tag, or revision. */
  async function checkout(request) {
    const root = await repoRoot(request?.dir);
    const ref = typeof request?.ref === "string" ? request.ref.trim() : "";
    if (ref === "") throw new Error("git/checkout: a branch or revision is required");
    const local = await execGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`], { allowCodes: [0, 1] });
    if (local.code === 0) {
      await execGit(root, ["checkout", ref]);
      return { ok: true, detached: false, branch: ref };
    }
    const remote = await execGit(root, ["show-ref", "--verify", "--quiet", `refs/remotes/${ref}`], { allowCodes: [0, 1] });
    if (remote.code === 0) {
      const slash = ref.indexOf("/");
      const localName = slash === -1 ? ref : ref.slice(slash + 1);
      const exists = await execGit(root, ["show-ref", "--verify", "--quiet", `refs/heads/${localName}`], { allowCodes: [0, 1] });
      if (exists.code === 0) {
        await execGit(root, ["checkout", localName]);
        return { ok: true, detached: false, branch: localName };
      }
      await execGit(root, ["checkout", "-b", localName, "--track", ref]);
      return { ok: true, detached: false, branch: localName };
    }
    await execGit(root, ["checkout", ref]);
    return { ok: true, detached: true, branch: null };
  }

  /** Create a branch and check it out. */
  async function createBranch(request) {
    const root = await repoRoot(request?.dir);
    const name = typeof request?.name === "string" ? request.name.trim() : "";
    if (name === "") throw new Error("git/createBranch: a branch name is required");
    const start = typeof request?.start === "string" && request.start.trim() !== "" ? request.start.trim() : undefined;
    await execGit(root, start === undefined ? ["checkout", "-b", name] : ["checkout", "-b", name, start]);
    return { ok: true, branch: name };
  }

  /** Delete a local branch. */
  async function deleteBranch(request) {
    const root = await repoRoot(request?.dir);
    const name = typeof request?.name === "string" ? request.name.trim() : "";
    if (name === "") throw new Error("git/deleteBranch: a branch name is required");
    await execGit(root, ["branch", request?.force === true ? "-D" : "-d", name]);
    return { ok: true };
  }

  /** Rename a local branch. */
  async function renameBranch(request) {
    const root = await repoRoot(request?.dir);
    const from = typeof request?.from === "string" ? request.from.trim() : "";
    const to = typeof request?.to === "string" ? request.to.trim() : "";
    if (from === "" || to === "") throw new Error("git/renameBranch: both branch names are required");
    await execGit(root, ["branch", "-m", from, to]);
    return { ok: true };
  }

  /** Merge a revision into the current branch; conflicts are reported, not thrown. */
  async function merge(request) {
    const root = await repoRoot(request?.dir);
    const ref = typeof request?.ref === "string" ? request.ref.trim() : "";
    if (ref === "") throw new Error("git/merge: a branch or revision is required");
    const argv = ["merge", "--no-edit"];
    if (request?.noFf === true) argv.push("--no-ff");
    if (request?.squash === true) argv.push("--squash");
    argv.push(ref);
    const result = await execGit(root, argv, { allowCodes: [0, 1] });
    return conflictOrThrow("merge", result);
  }

  /** Rebase the current branch onto a revision; conflicts are reported. */
  async function rebase(request) {
    const root = await repoRoot(request?.dir);
    const onto = typeof request?.onto === "string" ? request.onto.trim() : "";
    if (onto === "") throw new Error("git/rebase: a branch or revision is required");
    const result = await execGit(root, ["rebase", onto], { allowCodes: [0, 1] });
    return conflictOrThrow("rebase", result);
  }

  /** Cherry-pick one commit; conflicts are reported. */
  async function cherryPick(request) {
    const root = await repoRoot(request?.dir);
    const hash = typeof request?.hash === "string" ? request.hash.trim() : "";
    if (hash === "") throw new Error("git/cherryPick: a commit hash is required");
    const result = await execGit(root, ["cherry-pick", hash], { allowCodes: [0, 1] });
    return conflictOrThrow("cherry-pick", result);
  }

  /** Revert one commit without opening an editor. */
  async function revert(request) {
    const root = await repoRoot(request?.dir);
    const hash = typeof request?.hash === "string" ? request.hash.trim() : "";
    if (hash === "") throw new Error("git/revert: a commit hash is required");
    const result = await execGit(root, ["revert", "--no-edit", hash], { allowCodes: [0, 1] });
    return conflictOrThrow("revert", result);
  }

  /** Reset the current branch to a revision. */
  async function reset(request) {
    const root = await repoRoot(request?.dir);
    const ref = typeof request?.ref === "string" && request.ref.trim() !== "" ? request.ref.trim() : "HEAD";
    const mode = request?.mode === "soft" || request?.mode === "hard" ? request.mode : "mixed";
    await execGit(root, ["reset", `--${mode}`, ref]);
    return { ok: true };
  }

  /** Read a page of the commit log. */
  async function log(request) {
    const root = await repoRoot(request?.dir);
    const ref = typeof request?.ref === "string" && request.ref.trim() !== "" ? request.ref.trim() : "HEAD";
    const limit = positiveInt(request?.limit, 50, 500);
    const skip = positiveInt(request?.skip, 0, 100_000);
    const format = ["%h", "%H", "%an", "%ar", "%s", "%D", "%P", "%ad", "%ae"].join("%x01");
    // One extra row tells the pager whether more history exists without
    // reporting the final page as "full".
    const argv = ["log", `--max-count=${String(limit + 1)}`, `--skip=${String(skip)}`, "--date=format:%b %d, %Y at %H:%M", `--pretty=format:${format}`, ref];
    const result = await execGit(root, argv, { allowCodes: [0, 128] });
    if (result.code !== 0) {
      if (/does not have any commits yet|unknown revision/u.test(result.stderr)) {
        return { commits: [], hasMore: false };
      }
      throw new Error(`git log failed: ${tail(result.stderr)}`);
    }
    const rows = [];
    for (const line of result.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const [shortHash, hash, author, date, subject, decorations, parents, fullDate, email] = splitFields(line, "\u0001");
      rows.push({
        shortHash,
        hash,
        author,
        date,
        subject,
        decorations: decorations ?? "",
        parents: (parents ?? "").split(" ").filter((x) => x !== ""),
        fullDate: fullDate ?? "",
        email: email ?? "",
      });
    }
    return { commits: rows.slice(0, limit), hasMore: rows.length > limit };
  }

  /** Read one commit or stash entry with its patch. */
  async function show(request) {
    const root = await repoRoot(request?.dir);
    const hash = typeof request?.hash === "string" ? request.hash.trim() : "";
    if (hash === "") throw new Error("git/show: a commit is required");
    const metaFormat = ["%H", "%an", "%ae", "%ar", "%s", "%D", "%B", "%cn", "%ce", "%ad", "%cd", "%P"].join("%x01");
    const [meta, patch] = await Promise.all([
      execGit(root, ["show", "--no-patch", "--date=format:%B %d, %Y at %H:%M:%S GMT%z", `--format=${metaFormat}`, hash], { allowCodes: [0, 128] }),
      execGit(root, ["--no-pager", "show", "--no-color", "--format=", "--stat", "--patch", hash], {
        allowCodes: [0, 128],
        maxBytes: 4 * 1024 * 1024,
      }),
    ]);
    if (meta.code !== 0) throw new Error(`git show ${hash} failed: ${tail(meta.stderr)}`);
    const fields = splitFields(meta.stdout, "\u0001");
    return {
      hash: fields[0] ?? hash,
      author: fields[1] ?? "",
      email: fields[2] ?? "",
      date: fields[3] ?? "",
      subject: fields[4] ?? "",
      decorations: fields[5] ?? "",
      body: (fields[6] ?? "").replace(/\n+$/u, ""),
      committer: fields[7] ?? "",
      committerEmail: fields[8] ?? "",
      authorDate: fields[9] ?? "",
      committerDate: (fields[10] ?? "").replace(/\n+$/u, ""),
      parents: (fields[11] ?? "").trim().split(" ").filter((x) => x !== ""),
      patch: patch.stdout,
    };
  }

  /** List stash entries, newest first. */
  async function stashList(request) {
    const root = await repoRoot(request?.dir);
    const result = await execGit(root, ["stash", "list", "--format=%gd%x1f%s%x1f%cr"], { allowCodes: [0, 1] });
    const stashes = [];
    for (const line of result.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const [ref, message, date] = splitFields(line);
      stashes.push({ index: stashes.length, ref, message, date });
    }
    return { stashes };
  }

  /** Stash the working tree, optionally including untracked files. */
  async function stashSave(request) {
    const root = await repoRoot(request?.dir);
    const message = typeof request?.message === "string" && request.message.trim() !== "" ? request.message.trim() : `WIP on ${new Date().toISOString()}`;
    const argv = ["stash", "push", "-m", message];
    if (request?.includeUntracked === true) argv.push("--include-untracked");
    const result = await execGit(root, argv);
    return { ok: true, output: result.stdout.trim() };
  }

  /** Apply one stash entry without dropping it. */
  async function stashApply(request) {
    return stashAction(request, "apply");
  }

  /** Pop one stash entry. */
  async function stashPop(request) {
    return stashAction(request, "pop");
  }

  /** Drop one stash entry. */
  async function stashDrop(request) {
    return stashAction(request, "drop");
  }

  /** Run apply/pop/drop against `stash@{n}`. */
  async function stashAction(request, action) {
    const root = await repoRoot(request?.dir);
    const index = Math.max(0, Math.trunc(Number(request?.index ?? 0)) || 0);
    const ref = `stash@{${String(index)}}`;
    const result = await execGit(root, ["stash", action, ref], { allowCodes: [0, 1] });
    return {
      ok: result.code === 0,
      conflicts: result.code !== 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }

  /** List configured remotes. */
  async function remotes(request) {
    const root = await repoRoot(request?.dir);
    const result = await execGit(root, ["remote", "-v"], { allowCodes: [0, 1] });
    const byName = new Map();
    for (const line of result.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const parts = line.split(/\s+/u);
      const [name, url, kind] = parts;
      if (name === undefined || url === undefined) continue;
      const existing = byName.get(name) ?? { name, fetchUrl: "", pushUrl: "" };
      if (kind === "(push)") existing.pushUrl = url;
      else existing.fetchUrl = url;
      byName.set(name, existing);
    }
    return { remotes: [...byName.values()] };
  }

  /** Fetch from every remote (or one), pruning deleted refs. */
  async function fetch(request) {
    const root = await repoRoot(request?.dir);
    const remote = typeof request?.remote === "string" && request.remote.trim() !== "" ? request.remote.trim() : null;
    const argv = remote === null ? ["fetch", "--all", "--prune"] : ["fetch", "--prune", remote];
    const result = await execGit(root, argv, { timeoutMs: NETWORK_TIMEOUT_MS });
    return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
  }

  /** Pull the configured upstream. */
  async function pull(request) {
    const root = await repoRoot(request?.dir);
    const result = await execGit(root, ["pull"], { timeoutMs: NETWORK_TIMEOUT_MS, allowCodes: [0, 1] });
    const stdout = result.stdout.trim();
    const stderr = result.stderr.trim();
    if (result.code === 0) return { ok: true, conflicts: false, stdout, stderr };
    // "There is no tracking information", authentication, and unreachable
    // remotes are configuration failures, not conflicts the user can resolve
    // in the file list.
    return { ok: false, conflicts: looksLikeConflict(result), stdout, stderr };
  }

  /** Push the current branch. */
  async function push(request) {
    const root = await repoRoot(request?.dir);
    const remote = typeof request?.remote === "string" && request.remote.trim() !== "" ? request.remote.trim() : null;
    const branch = typeof request?.branch === "string" && request.branch.trim() !== "" ? request.branch.trim() : null;
    const argv = ["push"];
    if (request?.force === true) argv.push("--force-with-lease");
    if (request?.setUpstream === true) {
      if (remote === null) throw new Error("git/push: a remote is required to set an upstream");
      argv.push("-u", remote);
      if (branch !== null) argv.push(branch);
    } else if (remote !== null) {
      argv.push(remote);
      if (branch !== null) argv.push(branch);
    }
    const result = await execGit(root, argv, { timeoutMs: NETWORK_TIMEOUT_MS, allowCodes: [0, 1] });
    return {
      ok: result.code === 0,
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
    };
  }

  /** List tags, newest first. */
  async function tags(request) {
    const root = await repoRoot(request?.dir);
    const format = ["%(refname:short)", "%(*objectname:short)", "%(objectname:short)", "%(creatordate:relative)", "%(subject)"].join("%01");
    const result = await execGit(root, ["for-each-ref", "--sort=-creatordate", `--format=${format}`, "refs/tags"], { allowCodes: [0, 1] });
    const rows = [];
    for (const line of result.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const [name, peeled, object, date, subject] = splitFields(line, "\u0001");
      rows.push({ name, tip: peeled || object, date, subject: subject ?? "" });
    }
    return { tags: rows };
  }

  /** Create a lightweight or annotated tag. */
  async function createTag(request) {
    const root = await repoRoot(request?.dir);
    const name = typeof request?.name === "string" ? request.name.trim() : "";
    if (name === "") throw new Error("git/createTag: a tag name is required");
    const ref = typeof request?.ref === "string" && request.ref.trim() !== "" ? request.ref.trim() : undefined;
    const message = typeof request?.message === "string" && request.message.trim() !== "" ? request.message : undefined;
    const argv = message === undefined ? ["tag", name] : ["tag", "-a", name, "-m", message];
    if (ref !== undefined) argv.push(ref);
    await execGit(root, argv);
    return { ok: true };
  }

  /** Delete a tag. */
  async function deleteTag(request) {
    const root = await repoRoot(request?.dir);
    const name = typeof request?.name === "string" ? request.name.trim() : "";
    if (name === "") throw new Error("git/deleteTag: a tag name is required");
    await execGit(root, ["tag", "-d", name]);
    return { ok: true };
  }

  /** Read recent reflog entries for undo. */
  async function reflog(request) {
    const root = await repoRoot(request?.dir);
    const limit = positiveInt(request?.limit, 50, 500);
    const format = ["%h", "%gd", "%gs", "%ar"].join("%x01");
    const result = await execGit(root, ["reflog", `--max-count=${String(limit)}`, "--date=relative", `--format=${format}`], { allowCodes: [0, 128] });
    const entries = [];
    for (const line of result.stdout.split("\n")) {
      if (line.trim() === "") continue;
      const [shortHash, selector, subject, date] = splitFields(line, "\u0001");
      entries.push({ shortHash, selector, subject, date });
    }
    return { entries };
  }

  /** List linked worktrees, flagging the main, current, locked and prunable ones. */
  async function worktrees(request) {
    const root = await repoRoot(request?.dir);
    const result = await execGit(root, ["worktree", "list", "--porcelain"], { allowCodes: [0, 1] });
    const rows = [];
    let current = null;
    for (const line of result.stdout.split("\n")) {
      if (line === "") {
        if (current !== null) rows.push(current);
        current = null;
        continue;
      }
      const space = line.indexOf(" ");
      const key = space === -1 ? line : line.slice(0, space);
      const value = space === -1 ? "" : line.slice(space + 1);
      current ??= {
        path: "",
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        lockReason: "",
        prunable: false,
        prunableReason: "",
      };
      if (key === "worktree") current.path = value;
      else if (key === "HEAD") current.head = value;
      else if (key === "branch") current.branch = value.replace(/^refs\/heads\//u, "");
      else if (key === "detached") current.detached = true;
      else if (key === "bare") current.bare = true;
      else if (key === "locked") {
        current.locked = true;
        // A quoted reason (unusual characters) is unescaped by git's own rules.
        current.lockReason = value.replace(/^"|"$/gu, "").replace(/\\n/gu, "\n");
      } else if (key === "prunable") {
        current.prunable = true;
        current.prunableReason = value;
      }
    }
    if (current !== null) rows.push(current);
    const currentRow = rows.find((row) => samePath(row.path, root)) ?? null;
    for (const [index, row] of rows.entries()) {
      row.main = index === 0;
      row.isCurrent = row === currentRow;
    }
    return { root, worktrees: rows };
  }

  /** Create a linked worktree on a new branch, an existing branch or detached. */
  async function addWorktree(request) {
    const root = await repoRoot(request?.dir);
    const path = worktreePath(request?.path, "addWorktree");
    const branch = revisionArg(request?.branch, "addWorktree", "a branch name");
    const start = revisionArg(request?.start, "addWorktree", "a start point");
    const create = request?.createBranch === true;
    const detached = request?.detached === true;
    if (create && detached) throw new Error("git/addWorktree: a new branch and a detached HEAD are mutually exclusive");
    const argv = ["worktree", "add"];
    if (detached) {
      argv.push("--detach");
    } else if (create) {
      if (branch === undefined) throw new Error("git/addWorktree: a branch name is required to create a branch");
      argv.push("-b", branch);
    } else if (branch === undefined) {
      throw new Error("git/addWorktree: a branch name is required");
    }
    argv.push("--", path);
    if (detached) argv.push(start ?? "HEAD");
    else if (create) {
      if (start !== undefined) argv.push(start);
    } else {
      argv.push(branch);
    }
    await execGit(root, argv, { timeoutMs: 120_000 });
    return { ok: true, path };
  }

  /** Remove one linked worktree (its directory included). */
  async function removeWorktree(request) {
    const root = await repoRoot(request?.dir);
    const path = worktreePath(request?.path, "removeWorktree");
    const argv = ["worktree", "remove"];
    if (request?.force === true) argv.push("--force");
    argv.push("--", path);
    await execGit(root, argv);
    return { ok: true, path };
  }

  /** Move one linked worktree to a new path. */
  async function moveWorktree(request) {
    const root = await repoRoot(request?.dir);
    const from = worktreePath(request?.from, "moveWorktree");
    const to = worktreePath(request?.to, "moveWorktree");
    await execGit(root, ["worktree", "move", "--", from, to]);
    return { ok: true, from, to };
  }

  /** Lock a worktree so prune and remove leave it alone. */
  async function lockWorktree(request) {
    const root = await repoRoot(request?.dir);
    const path = worktreePath(request?.path, "lockWorktree");
    const reason = typeof request?.reason === "string" ? request.reason.trim() : "";
    const argv = ["worktree", "lock"];
    if (reason !== "") argv.push("--reason", reason);
    argv.push("--", path);
    await execGit(root, argv);
    return { ok: true, path };
  }

  /** Unlock a worktree. */
  async function unlockWorktree(request) {
    const root = await repoRoot(request?.dir);
    const path = worktreePath(request?.path, "unlockWorktree");
    await execGit(root, ["worktree", "unlock", "--", path]);
    return { ok: true, path };
  }

  /**
   * Prune administrative files for worktrees whose directories are gone.
   * `dryRun` reports what would be removed without touching anything; the
   * verbose wording is rewritten so the panel can show it as a preview.
   */
  async function pruneWorktrees(request) {
    const root = await repoRoot(request?.dir);
    const dryRun = request?.dryRun === true;
    const argv = ["worktree", "prune", "--verbose"];
    if (dryRun) argv.push("--dry-run");
    const result = await execGit(root, argv, { allowCodes: [0] });
    let output = `${result.stdout}\n${result.stderr}`.trim();
    if (dryRun) output = output.replace(/^Removing /gmu, "Would remove ");
    return { dryRun, output };
  }


  /** Initialize a repository in a directory. */
  async function initRepo(request) {
    const dir = request?.dir;
    if (typeof dir !== "string" || dir === "") throw new Error("git/initRepo: a directory is required");
    const result = await execGit(dir, ["init"]);
    return { ok: true, stdout: result.stdout.trim() };
  }

  /** Abort whatever multi-commit operation is in progress. */
  async function abortOperation(request) {
    const kind = typeof request?.kind === "string" ? request.kind : "";
    const mapping = {
      merge: ["merge", "--abort"],
      rebase: ["rebase", "--abort"],
      cherryPick: ["cherry-pick", "--abort"],
      revert: ["revert", "--abort"],
      am: ["am", "--abort"],
      bisect: ["bisect", "reset"],
    };
    const argv = mapping[kind];
    if (argv === undefined) throw new Error(`git/abortOperation: unknown operation "${kind}"`);
    const root = await repoRoot(request?.dir);
    const result = await execGit(root, argv, { allowCodes: [0, 1] });
    if (result.code !== 0) throw new Error(`git ${argv.join(" ")} failed: ${tail(result.stderr) || "no operation in progress"}`);
    return { ok: true };
  }

  /**
   * Escape hatch for advanced commands the panel does not model directly.
   * The argv is literal (no shell) and must be non-empty.
   */
  async function run(request) {
    const args = Array.isArray(request?.args) ? request.args : [];
    if (args.length === 0 || args.some((value) => typeof value !== "string")) {
      throw new Error("git/run: args must be a non-empty array of strings");
    }
    const root = await repoRoot(request?.dir);
    const result = await execGit(root, args, {
      stdin: typeof request?.stdin === "string" ? request.stdin : undefined,
      timeoutMs: request?.network === true ? NETWORK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
    });
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  }

  const api = {
    typertRemote: null,
    status,
    diff,
    image,
    stage,
    unstage,
    discard,
    stageLines,
    commit,
    lastCommitMessage,
    branches,
    checkout,
    createBranch,
    deleteBranch,
    renameBranch,
    merge,
    rebase,
    cherryPick,
    revert,
    reset,
    log,
    show,
    stashList,
    stashSave,
    stashApply,
    stashPop,
    stashDrop,
    remotes,
    fetch,
    pull,
    push,
    tags,
    createTag,
    deleteTag,
    reflog,
    worktrees,
    addWorktree,
    removeWorktree,
    moveWorktree,
    lockWorktree,
    unlockWorktree,
    pruneWorktrees,
    initRepo,
    abortOperation,
    run,
  };

  return api;
}

export { PACKAGE_NAME };
