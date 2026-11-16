# Host git engine — independent test findings

> **Status: all 13 findings below are fixed.** `node test/host-suite.mjs` now
> reports `SUMMARY: 86 tests — 86 passed, 0 failed, 0 known-bug, 0 skipped`, and
> every former `knownBug(...)` wrapper was converted to a normal regression
> test (the `knownBug` helper remains available in the harness but no test uses
> it). The write-ups below are kept as the reproduction record. Fixes:
>
> | ID | Fix |
> | --- | --- |
> | HOST-01/02/12 | `buildPartialPatch(patch, selected, reverse)` now converts unselected `-` lines to context for a forward patch and unselected `+` lines to context for a reverse patch, so the side git matches stays contiguous. |
> | HOST-03/07 | Partial whole-file additions/deletions rewrite the `/dev/null` header on the matched side (dropping the mode/index lines) and lift a zero hunk start to 1. |
> | HOST-04/05 | Untracked diffs run from the repository root with a repo-relative path, so headers are `a/new.txt` / `b/new.txt`. |
> | HOST-06 | `\ No newline at end of file` markers survive only with the line they belong to; a partial selection inside a marker-bearing hunk is rejected (empty partial) instead of emitting a self-contradictory patch. |
> | HOST-08 | `show.body` strips the format terminator so it matches `lastCommitMessage`. |
> | HOST-09 | `log` fetches `limit + 1` rows and reports `hasMore` from the remainder. |
> | HOST-10 | `context: 0` is honoured (`-U0`); only an absent value falls back to 3. |
> | HOST-11 | `pull` reports `conflicts: false` for non-conflict failures such as a missing upstream. |
> | HOST-13 | `merge`/`rebase`/`cherry-pick`/`revert` reject non-conflict failures with git's diagnostic instead of reporting a conflict. |
>
> `buildPartialPatch(patch, selected)` remains the forward default; callers
> pass `reverse = true` for the unstaging direction, which `stageLines` does
> from its `staged` field.

Scope: the Host half of `@local/dsh-git` (`index.js`), exercised through the
real `node:child_process`-backed `ctx.subprocess` mock (`test/mock-ctx.mjs`).

Run everything:

```sh
node test/host-suite.mjs
```

The suite is green: every non-known-bug test passes, and the 13 product bugs
below are encoded as `knownBug(...)` tests that assert the **correct** behaviour.
While a bug is present those tests fail and are reported as `KNOWN HOST-xx`
(not suite failures). If one starts passing the suite reports `XPASS` and exits
non-zero so the finding can be retired. `STRICT_BUGS=1 node test/host-suite.mjs`
exits non-zero while any known bug is still open.

Every known-bug test proves the expected state is reachable: where the bug is in
`buildPartialPatch`/`stageLines`, the test first applies a hand-written
reference patch with plain `git apply --cached` (and checks `git show :path`),
then shows the implementation's patch does not apply. Fixtures are isolated
`mkdtemp` repositories removed in `finally`; expectations are derived from the
`git` CLI, not from the implementation.

Severity: **High** = data corruption / a documented operation does not work;
**Medium** = operation fails for a legitimate selection; **Low** = wrong
metadata / convenience field.

---

## HOST-01 — High — Partial staging drops unselected `-` lines instead of keeping them as context

Suite test: `HOST-01` — `partial/only-added-line-keeps-unselected-deletion-as-context`.

Scenario: one file, `ctx1 / OLD / ctx2` at HEAD; worktree replaces `OLD` with
`NEW`. The user selects only the added line `+NEW` (the API explicitly accepts
raw body-line indexes; the locale advertises line-level staging).

`buildPartialPatch` drops the unselected `-OLD`, yielding:

```diff
@@ -1,2 +1,3 @@
 ctx1
+NEW
 ctx2
```

`git apply --cached` then fails:

```
error: patch failed: f.txt:1
error: f.txt: patch does not apply
```

Expected: an unselected deletion stays in the index, so it must be kept as a
context line. This reference patch applies and stages exactly the added line:

```diff
@@ -1,3 +1,4 @@
 ctx1
 OLD
+NEW
 ctx2
```

Résumé: `stageLines(...)` rejects with the opaque `patch does not apply`; a
legitimate one-line staging selection is impossible for any `-`/`+` pair.

Minimal reproduction (git only):

```sh
d=$(mktemp -d); cd "$d"; git init -q -b main
git config user.email t@e.com; git config user.name T; git config commit.gpgsign false
printf 'ctx1\nOLD\nctx2\n' > f.txt; git add -A; git commit -q -m init
printf 'ctx1\nNEW\nctx2\n' > f.txt
git diff -U3 -- f.txt
# feed the implementation partial (the @@ -1,2 +1,3 @@ patch above, with headers)
git apply --cached --whitespace=nowarn   # -> "patch does not apply"
```

---

## HOST-02 — High — Reverse unstage of only a deleted line cannot apply

Suite test: `HOST-02` — `stageLines/reverse-unstage-only-a-deleted-line`.

Same fixture, but `git add f.txt` first and the user unstages only the
`-OLD` line. The partial patch is `@@ -1,3 +1,2 @@ ctx1 / -OLD / ctx2`; reversed
application to the index fails because the index still has `NEW`, while the
patch's new side is `ctx1 / ctx2`. Expected: unselected `+NEW` is kept as a
context line so the reverse patch's target side matches the index:

```diff
@@ -1,4 +1,3 @@
 ctx1
-OLD
 NEW
 ctx2
```

`git apply --cached --reverse` on that reference yields index
`ctx1 / OLD / NEW / ctx2`, i.e. the deletion was unstaged and the addition stays
staged.

---

## HOST-03 — High — Partial staging of a whole-file deletion produces an invalid patch

Suite test: `HOST-03` — `partial/pure-file-deletion-line-subset`.

Scenario: `del.txt` (`d1..d4`) is deleted in the worktree; the user stages only
the removal of `d2`. The implementation keeps the whole-file-deletion headers
and does not shift `oldStart`:

```diff
diff --git a/del.txt b/del.txt
deleted file mode 100644
index 28bf05d..0000000
--- a/del.txt
+++ /dev/null
@@ -1,1 +0,0 @@
-d2
```

`git apply --cached` → `error: patch failed: del.txt:1 / patch does not apply`
(the file may not disappear, so `+++ /dev/null` and the stale start are wrong).
Expected: a modification-style patch with unselected deletions as context:

```diff
--- a/del.txt
+++ b/del.txt
@@ -1,4 +1,3 @@
 d1
-d2
 d3
 d4
```

This applies and leaves `d1 / d3 / d4` in the index (verified in the suite).

---

## HOST-04 — Medium — Untracked diffs use absolute paths in their headers

Suite test: `HOST-04` — `diff/untracked-patch-headers-are-repo-relative`.

`api.diff({ dir, path: "new.txt", untracked: true })` runs
`git diff --no-index /dev/null <absolute path>` but keeps only the stdout, so the
patch is:

```diff
diff --git a/private/var/folders/…/new.txt b/private/var/folders/…/new.txt
--- /dev/null
+++ b/private/var/folders/…/new.txt
```

All other diffs (tracked/staged) are repository-relative. Expected:
`+++ b/new.txt`. This is also the root cause of HOST-05.

Command:

```sh
node --input-type=module -e '
import {createApi} from "./index.js";
import {createMockContext} from "./test/mock-ctx.mjs";
import {mkdtempSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const dir=mkdtempSync(join(tmpdir(),"git-"));
import {execFileSync} from "node:child_process";
execFileSync("git",["init","-q","-b","main"],{cwd:dir});
writeFileSync(join(dir,"new.txt"),"alpha\nbeta\n");
const api=createApi(createMockContext());
console.log((await api.diff({dir,path:"new.txt",untracked:true})).patch);
'
```

---

## HOST-05 — High — `stageLines` on an untracked diff writes a bogus path into the index

Suite test: `HOST-05` — `stageLines/untracked-file-stages-the-repo-relative-path`.

Feeding the patch from HOST-04 back into `stageLines` (selecting `+alpha` and
`+gamma`) reports `{ ok: true }`, but the index contains:

```
private/var/folders/…/T/git-for-claude-suite-XXXX/new.txt
```

and the real `new.txt` is left untracked. Users see a "staged" file that does not
exist in their repository, while their actual file is not staged.

Expected: `git diff --cached --name-only` → `new.txt` with content
`alpha\ngamma\n` (a repo-relative reference patch produces exactly that, see the
passing test `stageLines/add-only-file-from-relative-patch`).

---

## HOST-06 — Medium — `\ No newline at end of file` marker is kept after its line is dropped

Suite test: `HOST-06` — `partial/no-newline-marker-not-kept-for-dropped-line`.

Fixture: file `one\ntwo` (no trailing newline), worktree `one\nTWO`; select only
`+TWO`. The marker that belongs to the dropped `-two` is still emitted because
the implementation only checks whether *anything* earlier was selected:

```diff
@@ -1,1 +1,2 @@
 one
\ No newline at end of file
+TWO
\ No newline at end of file
```

That claims the context line `one` has no newline, so `git apply` fails
(`patch does not apply`). Expected: the marker follows the line before it — if
that line is dropped, drop the marker too (and reject the selection cleanly when
nothing representable remains), never emit a self-contradictory patch.

---

## HOST-07 — Medium — Reverse unstage of one line of a staged new file cannot apply

Suite test: `HOST-07` — `stageLines/reverse-unstage-middle-line-of-staged-new-file`.

Staged new file `alpha/beta/gamma`; the user unstages only `+beta`. The partial
keeps the `new file mode` header and the original `newStart`:

```diff
@@ -0,0 +1,1 @@
+beta
```

Even ignoring the file headers, the new-side start must be `2` (two lines precede
it), and the index still exists so the headers must be modification-style.
Expected reference (applies with `git apply --cached --reverse`, leaving
`alpha/gamma` in the index):

```diff
--- a/new.txt
+++ b/new.txt
@@ -1,2 +1,3 @@
 alpha
+beta
 gamma
```

---

## HOST-08 — Low — `show.body` keeps a trailing newline, `lastCommitMessage` strips it

Suite test: `HOST-08` — `show/body-matches-lastCommitMessage`.

Commit message `"show subject\n\nshow body line"`:

- `api.lastCommitMessage(...).message` → `"show subject\n\nshow body line"`
- `api.show(...).body` → `"show subject\n\nshow body line\n"`

The two APIs describe the same commit message but disagree by one trailing
newline, because `show` removes only one of the two newlines that `%B` plus the
format terminator produce. Expected: both expose the same body.

---

## HOST-09 — Low — `log.hasMore` is true on the final page

Suite test: `HOST-09` — `log/hasMore-false-on-the-last-page`.

Five commits, `api.log({ skip: 3, limit: 2 })` returns the last two commits
(`hasMore: true`) although no commits remain. `hasMore` is computed as
`commits.length === limit`, so a pager always issues one useless extra request
(and can keep a "loading" affordance alive). Expected `hasMore: false` when the
page is the end of the history (e.g. fetch `limit + 1` and report the remainder).

---

## HOST-10 — Low — `diff({ context: 0 })` is silently treated as `context: 3`

Suite test: `HOST-10` — `diff/context-zero-is-honoured`.

`git diff -U0` is a valid zero-context diff, but `positiveInt(0, 3, 40)` falls
back to 3, so a caller can never request it:

```
context: 0 -> @@ -3,7 +3,7 @@ line 2   (3 context lines)
```

Expected: `context: 0` produces the `-U0` patch (and `context` out of range still
clamps safely).

---

## HOST-11 — Low — `pull` without an upstream reports `conflicts: true`

Suite test: `HOST-11` — `pull/no-upstream-is-not-reported-as-a-conflict`.

A repository with no upstream returns:

```json
{ "ok": false, "conflicts": true, "stderr": "There is no tracking information for the current branch. …" }
```

`conflicts` is derived from the exit code, but a configuration error is not a
merge conflict; a UI that switches to conflict-resolution mode on `conflicts`
shows the wrong screen. Expected `conflicts: false` (or an explicit
no-upstream error) when git reports a non-conflict failure.

---

## HOST-12 — Medium — Reverse unstage of one added line inside a contiguous added block

Suite test: `HOST-12` — `stageLines/reverse-unstage-one-added-line-of-a-block`.

Staged diff inserts `a1, a2, a3` after line 3; unstage only `+a2`. The partial
drops `+a1`/`+a3`, so its new side (`l1 l2 l3 a2 l4…`) does not match the index
(`l1 l2 l3 a1 a2 a3 l4…`) and `git apply --cached --reverse` fails. Expected:
keep the unselected additions as context (reference patch verified in the test:
`@@ -1,8 +1,9 @@` with `a1`, `+a2`, `a3`), leaving `a1/a3` staged and `a2` unstaged.

This is the reverse-direction twin of HOST-02.

---

## HOST-13 — Medium — `merge` with an unknown ref is reported as a conflict

Suite test: `HOST-13` — `merge/bad-ref-rejects-with-a-useful-message`.

`git merge no-such-branch` exits 1 with
`merge: no-such-branch - not something we can merge`. `merge()` treats exit 1 as
a conflict and resolves `{ ok: false, conflicts: true }` with empty/irrelevant
stdout, so the caller cannot distinguish a typo from a real conflict and gets no
useful diagnostic. Expected: reject with the git stderr (the task's "bad ref
rejects with a useful message"), like `rebase`/`cherryPick`/`revert`/`show`
already do for their bad refs.

---

# Observations that are not filed as bugs

- **status counts on conflicts**: an unmerged file has `x = "U"` and `y = "U"`,
  so it contributes to both `counts.staged` and `counts.unstaged` on top of
  `counts.conflicts`. This may be intentional (the panel can render both sides),
  but it is worth a product decision; it is not encoded as a failure.
- **stash actions on a bad index**: `stashApply({ index: 9 })` rejects
  (`git … failed (128): fatal: log for 'stash' only has 1 entries`) instead of
  resolving `{ ok: false }`. The message is useful; the contract here is
  undocumented.
- **Typert descriptor table**: every `invocation(...)` call passes a per-field
  descriptor array as a third argument, but `invocation(method, description)`
  only takes two parameters — the arrays are silently ignored dead code, and the
  module comment ("maps those fields onto the handler's positional parameters in
  declaration order") is stale. The actual exported contract is consistent with
  the documented one-request-object convention: all 37 invocations declare
  exactly one `request` field with `wire: "request"`, and every handler takes a
  single request object (verified by `contract/typert-invocations-match-api-and-request-object-shape`).
- `api.typertRemote.service` points back at the service object (circular); it is
  frozen but not JSON-serialisable. No test relies on serialising it.
