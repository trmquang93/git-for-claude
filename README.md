# git-for-claude

A lazygit-style Git pane for Claude Desktop, converted from the `@local/dsh-git`
panel for the DeepSeek Harness. Type `/git` to open it beside the chat.

The pane follows the Fork layout: repository tabs on top, a toolbar (Fetch, Pull, Push,
Stash, New Branch, Undo), and a sidebar with Local Changes, All Commits, Branches
(nested by `/`), Remotes, Tags, Stashes, Worktrees and Reflog. All Commits is a table
(graph dot, subject with branch, remote and tag badges, author, SHA, date). The detail
under it has Commit (author, committer, refs, SHA, parent links, message, files),
Changes (per-file diffs) and File Tree tabs. Local Changes groups files with a checkbox
each, a diff beside them and a commit box under the list. You can stage whole files,
hunks or single lines, commit and amend, switch and create branches, merge, rebase,
cherry-pick, revert, reset, stash, tag, fetch, pull, push, manage linked worktrees,
preview changed images before and after, and undo the last action. Everything is
clickable; hotkeys: `1` Local Changes, `2` All Commits, `3` branches, `4` stashes,
`c` commit, `f` fetch, `l` pull, `p` push, `u` undo, `r` refresh.

Claude extras: the pane refreshes after Claude edits files, the status line shows the
branch with ahead and behind counts, and "Send to chat" puts the selected diff or
commit in the prompt box.

## Install

At the prompt of a terminal session:

```
/plugin install git-for-claude --marketplace trmquang93/git-for-claude
```

From a shell:

```
claude plugin install git-for-claude --marketplace trmquang93/git-for-claude
```

Answer `y` to add the marketplace, then pick a scope.

## Develop and test in this repo

```
claude --plugin-dir .
```

Then type `/git` in a session whose folder is a git repository. Edits to `hooks/` reload
when the turn ends. Checks:

```
claude plugin validate .
claude plugin test .        # UI tests (hooks/*.test.tsx)
node test/host-suite.mjs    # engine tests against throwaway repositories
```

## How it works

`hooks/engine.ts` is the git engine ported from the harness (`index.js`): every
operation is one argv run through `$.process.run` (no shell). `hooks/view.tsx` draws the
pane with Claude Desktop's native elements (tabs, clickable rows, buttons, inputs, `Svg`
previews) and `hooks/register.tsx` runs the requests and hands back a fresh snapshot.

## Limits

- Git runs with repository hooks off (`$.process.run`), so commit hooks never run.
- Image previews cover images up to about 90 KB each (the `Svg` source is capped).
- Diffs are cut at 60,000 characters and long lists are trimmed.
- English only. Interactive rebase, submodules, LFS and forge features are not included.

## Tests

`node test/host-suite.mjs` runs the 96 engine tests against throwaway repositories.
