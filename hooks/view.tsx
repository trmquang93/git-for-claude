// Native Claude Desktop view of the Git pane, drawn by the hooks module with the
// desktop element table (no Client grid). `E` is `$.ui.resolve(e)`; `act` reaches
// git through register.tsx.
type Any = any

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i
const SURFACE = 'rgba(127,127,127,0.09)'
const HUNK_BG = 'rgba(56,139,253,0.14)'
const ADD_BG = 'rgba(46,160,67,0.28)'
const DEL_BG = 'rgba(248,81,73,0.28)'
const SUBS = ['Local', 'Remotes', 'Tags', 'Worktrees', 'Reflog']
const STATUS_WORD: Any = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', '?': 'New', T: 'Type' }
const STATUS_COLOR: Any = { M: 'warning', A: 'success', D: 'error', R: 'suggestion', C: 'suggestion', U: 'error', '?': 'success', T: 'warning' }
const STATUS_ICON: Any = { M: '◼', A: '✚', D: '━', R: '➜', C: '➜', U: '!', '?': '✚', T: '◼' }
const LIMIT = 14

export function initUi(): Any {
  return {
    tab: 'changes', sub: 0, sel: null, detail: null, detailKey: '', lines: [], sum: '', desc: '', commitN: 0, amend: false, fileView: {}, fetchedAt: 0, filter: '',
    dialog: null, log: [], notice: '', showAll: {}, collapsed: {}, more: null, hasMore: false, rev: -1, logOpen: false,
  }
}

// ---------------------------------------------------------------- model

function groups(files: Any[]) {
  const real = (f: Any) => f.kind !== 'untracked' && f.kind !== 'unmerged'
  return [
    { id: 'conflict', title: 'Conflicts', files: files.filter((f) => f.kind === 'unmerged') },
    { id: 'staged', title: 'Staged', files: files.filter((f) => real(f) && f.x !== '.') },
    { id: 'unstaged', title: 'Changes', files: files.filter((f) => real(f) && f.y !== '.') },
    { id: 'untracked', title: 'Untracked', files: files.filter((f) => f.kind === 'untracked') },
  ]
}

function letter(group: string, f: Any) {
  return group === 'staged' ? f.x : group === 'untracked' ? '?' : group === 'conflict' ? 'U' : f.y
}

function splitPath(path: string) {
  const i = path.lastIndexOf('/')
  return i < 0 ? { name: path, dir: '' } : { name: path.slice(i + 1), dir: path.slice(0, i + 1) }
}

function changedIndexes(patch: string): number[] {
  const out: number[] = []
  let inHunk = false
  patch.split('\n').forEach((l, i) => {
    if (l.startsWith('@@ ')) inHunk = true
    else if (inHunk && (l[0] === '+' || l[0] === '-')) out.push(i)
  })
  return out
}

function hunkOf(patch: string, idx: number): number[] {
  const lines = patch.split('\n')
  let start = -1
  for (let i = idx; i >= 0; i -= 1) if (lines[i]!.startsWith('@@ ')) { start = i; break }
  if (start < 0) return []
  const out: number[] = []
  for (let i = start + 1; i < lines.length && !lines[i]!.startsWith('@@ '); i += 1) if (lines[i]![0] === '+' || lines[i]![0] === '-') out.push(i)
  return out
}

// ---------------------------------------------------------------- replies + detail

export function onReply(ui: Any, reply: Any) {
  const stamp = new Date().toLocaleTimeString()
  const tag: string = reply.tag ?? ''
  if (!reply.ok) {
    ui.notice = String(reply.error ?? 'failed').split('\n').slice(0, 3).join(' ')
    if (tag === '' || tag === 'm') ui.log.push({ t: stamp, text: reply.label || reply.method, ok: false, err: ui.notice })
    return
  }
  if (tag.startsWith('detail:')) {
    if (tag.slice(7) === ui.detailKey) ui.detail = { key: tag.slice(7), ...(reply.data ?? {}) }
  } else if (tag === 'more') {
    ui.more = [...(ui.more ?? []), ...(reply.data?.commits ?? [])]
    ui.hasMore = reply.data?.hasMore === true
  } else if (tag === 'amendMsg') {
    const full = String(reply.data?.message ?? '')
    ui.sum = full.split('\n')[0] ?? ''
    ui.desc = full.split('\n').slice(2).join('\n')
    ui.commitN += 1
  } else if (tag === 'pruneDry') {
    const out = String(reply.data?.output ?? reply.data?.stdout ?? '').trim()
    ui.dialog = confirmDialog('Prune worktrees', out === '' ? 'Nothing to prune.' : out, out === '' ? null : { label: 'Prune', run: (c: Any) => c.m('pruneWorktrees', {}, 'git worktree prune') })
  } else if (tag !== 'quiet') {
    ui.notice = ''
    ui.log.push({ t: stamp, text: reply.label || reply.method, ok: true })
    if (ui.log.length > 100) ui.log.shift()
    if (reply.method === 'commit') { ui.sum = ''; ui.desc = ''; ui.amend = false; ui.commitN += 1 }
    if (reply.method === 'fetch' || reply.method === 'pull' || reply.method === 'push') ui.fetchedAt = Date.now()
  }
}

function listFor(ui: Any, snap: Any): Any[] {
  if (ui.tab === 'history') return [...(snap.commits ?? []), ...(ui.more ?? [])].map((c: Any) => ({ kind: 'commit', key: c.hash, c }))
  if (ui.tab === 'stash') return (snap.stashes ?? []).map((s: Any) => ({ kind: 'stash', key: s.ref, s }))
  if (ui.tab === 'branches') {
    if (ui.sub === 0) return [...(snap.branches?.local ?? [])].sort((a: Any, b: Any) => (a.current === b.current ? 0 : a.current ? -1 : 1)).map((b: Any) => ({ kind: 'local', key: b.name, b }))
    if (ui.sub === 1) return (snap.branches?.remote ?? []).map((b: Any) => ({ kind: 'remote', key: b.name, b }))
    if (ui.sub === 2) return (snap.tags ?? []).map((t: Any) => ({ kind: 'tag', key: t.name, t }))
    if (ui.sub === 3) return (snap.worktrees ?? []).map((w: Any) => ({ kind: 'worktree', key: w.path, w }))
    return (snap.reflog ?? []).map((r: Any) => ({ kind: 'reflog', key: r.selector, r }))
  }
  return []
}

function flatFiles(snap: Any, ui?: Any) {
  const out: Any[] = []
  for (const f of snap.status?.files ?? []) {
    const untracked = f.kind === 'untracked'
    const conflict = f.kind === 'unmerged'
    const staged = !untracked && !conflict && f.x !== '.'
    const unstaged = untracked || conflict || f.y !== '.'
    const want = ui?.fileView?.[f.path]
    const group = want === 'staged' && staged ? 'staged' : unstaged ? (untracked ? 'untracked' : conflict ? 'conflict' : 'unstaged') : 'staged'
    out.push({ kind: 'file', group, path: f.path, f, staged, unstaged })
  }
  return out.sort((x, y) => x.path.localeCompare(y.path))
}

function ago(ms: number) {
  if (!ms) return 'never'
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} minutes ago`
  return `${Math.floor(s / 3600)} hours ago`
}

function selectItem(c: Any, item: Any) {
  c.ui.sel = item
  c.ui.lines = []
  loadDetail(c, true)
  c.redraw()
}

function itemKey(it: Any) {
  return it === null || it === undefined ? '' : it.kind === 'file' ? `f|${it.path}` : `${it.kind}|${it.key}`
}

function loadDetail(c: Any, force = false) {
  const { ui, props } = c
  const it = ui.sel
  const key = `${itemKey(it)}|${it?.group ?? ''}|${props.rev}`
  if (!force && key === ui.detailKey) return
  ui.detailKey = key
  if (it === null || it === undefined) { ui.detail = null; return }
  ui.detail = { key, kind: 'loading' }
  let method = ''
  let request: Any = {}
  if (it.kind === 'file') {
    if (IMAGE.test(it.path)) { method = 'previewImage'; request = { path: it.path, staged: it.group === 'staged', untracked: it.group === 'untracked' } }
    else { method = 'diff'; request = { path: it.path, staged: it.group === 'staged', untracked: it.group === 'untracked', context: 3 } }
  } else if (it.kind === 'commit' || it.kind === 'stash') { method = 'show'; request = { hash: it.key } }
  else if (it.kind === 'local' || it.kind === 'remote') { method = 'log'; request = { ref: it.key, limit: 15 } }
  else if (it.kind === 'tag') { method = 'show'; request = { hash: it.key } }
  else if (it.kind === 'reflog') { method = 'show'; request = { hash: it.r.shortHash } }
  else { ui.detail = { key, kind: 'info' }; return }
  if (method !== 'previewImage') c.req('clearImage', {}, 'quiet')
  else ui.detail = { key, kind: 'image' }
  c.req(method, request, `detail:${key}`)
}

// ---------------------------------------------------------------- dialogs

function confirmDialog(title: string, message: string, ok: Any, flags: Any[] = []) {
  return { title, message, flags, fields: [], confirm: ok }
}
function promptDialog(title: string, fields: Any[], flags: Any[], label: string, run: Any, hint = '') {
  return { title, message: '', hint, flags, fields, submit: { label, run } }
}
const flagValues = (d: Any) => Object.fromEntries((d.flags ?? []).map((f: Any) => [f.name, f.on]))
const fieldValues = (d: Any) => Object.fromEntries((d.fields ?? []).map((f: Any) => [f.name, f.value]))

// ---------------------------------------------------------------- actions

const A: Any = {
  stage: (c: Any, paths: string[], label = '') => c.m('stage', { paths }, label || `stage ${paths.length === 1 ? paths[0] : paths.length + ' files'}`),
  unstage: (c: Any, paths: string[], label = '') => c.m('unstage', { paths }, label || `unstage ${paths.length === 1 ? paths[0] : paths.length + ' files'}`),
  discard(c: Any, it: Any) {
    c.ui.dialog = confirmDialog('Discard changes', `Discard changes to ${it.path}? This cannot be undone.`, {
      label: 'Discard', run: (cc: Any) => cc.m('discard', { paths: [it.path], untracked: it.group === 'untracked' }, `discard ${it.path}`),
    })
  },
  discardAll(c: Any) {
    const files = c.snap.status?.files ?? []
    const tracked = files.filter((f: Any) => f.kind !== 'untracked' && f.kind !== 'unmerged' && f.y !== '.').map((f: Any) => f.path)
    const untracked = files.filter((f: Any) => f.kind === 'untracked').map((f: Any) => f.path)
    c.ui.dialog = confirmDialog('Discard all changes', `Discard ${tracked.length} changed and ${untracked.length} untracked file(s)? This cannot be undone.`, {
      label: 'Discard all', run: (cc: Any) => {
        if (tracked.length > 0) cc.m('discard', { paths: tracked }, 'discard all changes')
        if (untracked.length > 0) cc.m('discard', { paths: untracked, untracked: true }, 'discard all untracked')
      },
    })
  },
  commit(c: Any) {
    const sum = String(c.ui.sum ?? '').trim()
    if (sum === '' && !c.ui.amend) { c.ui.notice = 'Write a commit summary first.'; c.redraw(); return }
    const desc = String(c.ui.desc ?? '').trim()
    const message = desc ? `${sum}\n\n${desc}` : sum
    c.m('commit', { message, amend: c.ui.amend }, `git commit${c.ui.amend ? ' --amend' : ''}`)
  },
  branchNew(c: Any) {
    c.ui.dialog = promptDialog('New branch', [{ name: 'name', label: 'Name', value: '' }, { name: 'start', label: 'Start point (optional)', value: '' }], [], 'Create',
      (cc: Any, v: Any) => cc.m('createBranch', { name: v.name, start: v.start }, `git checkout -b ${v.name}`))
  },
  tagNew(c: Any, it: Any) {
    c.ui.dialog = promptDialog(`Tag ${it.c.shortHash}`, [{ name: 'name', label: 'Name', value: '' }, { name: 'message', label: 'Message (annotated, optional)', value: '' }], [], 'Tag',
      (cc: Any, v: Any) => cc.m('createTag', { name: v.name, message: v.message, ref: it.key }, `git tag ${v.name}`))
  },
  stashNew(c: Any) {
    c.ui.dialog = promptDialog('Stash changes', [{ name: 'message', label: 'Message (optional)', value: '' }], [{ name: 'includeUntracked', label: 'Include untracked files', on: false }], 'Stash',
      (cc: Any, v: Any, f: Any) => cc.m('stashSave', { message: v.message, includeUntracked: f.includeUntracked }, 'git stash'))
  },
  push(c: Any) {
    const b = c.snap.status?.branch
    if (b?.name == null) return
    if (b.upstream) c.m('push', { branch: b.name }, 'git push')
    else c.m('push', { remote: 'origin', branch: b.name, setUpstream: true }, `git push -u origin ${b.name}`)
  },
  undo(c: Any) {
    c.ui.dialog = confirmDialog('Undo last action', 'Run git reset --hard HEAD@{1}? Uncommitted changes are lost.', { label: 'Undo', run: (cc: Any) => cc.m('reset', { ref: 'HEAD@{1}', mode: 'hard' }, 'git reset --hard HEAD@{1}') })
  },
  repo(c: Any) {
    const d: Any = promptDialog('Open repository', [{ name: 'dir', label: 'Folder path', value: c.props.dir ?? '' }], [], 'Open', (cc: Any, v: Any) => cc.req('setDir', { dir: v.dir }, 'quiet'))
    d.recents = c.props.recents ?? []
    d.init = c.snap.status?.isRepo === false
    c.ui.dialog = d
  },
  merge(c: Any, it: Any) {
    c.ui.dialog = confirmDialog('Merge', `Merge ${it.key} into ${c.branch ?? 'HEAD'}?`, { label: 'Merge', run: (cc: Any, f: Any) => cc.m('merge', { ref: it.key, noFf: f.noFf, squash: f.squash }, `git merge ${it.key}`) },
      [{ name: 'noFf', label: 'No fast-forward', on: false }, { name: 'squash', label: 'Squash', on: false }])
  },
  rebase: (c: Any, it: Any) => { c.ui.dialog = confirmDialog('Rebase', `Rebase ${c.branch ?? 'HEAD'} onto ${it.key}?`, { label: 'Rebase', run: (cc: Any) => cc.m('rebase', { onto: it.key }, `git rebase ${it.key}`) }) },
  rename: (c: Any, it: Any) => { c.ui.dialog = promptDialog('Rename branch', [{ name: 'to', label: 'New name', value: it.key }], [], 'Rename', (cc: Any, v: Any) => cc.m('renameBranch', { from: it.key, to: v.to }, `git branch -m ${it.key} ${v.to}`)) },
  deleteBranch: (c: Any, it: Any) => { c.ui.dialog = confirmDialog('Delete branch', `Delete local branch ${it.key}?`, { label: 'Delete', run: (cc: Any, f: Any) => cc.m('deleteBranch', { name: it.key, force: f.force }, `git branch -d ${it.key}`) }, [{ name: 'force', label: 'Force (unmerged)', on: false }]) },
  deleteTag: (c: Any, it: Any) => { c.ui.dialog = confirmDialog('Delete tag', `Delete tag ${it.key}?`, { label: 'Delete', run: (cc: Any) => cc.m('deleteTag', { name: it.key }, `git tag -d ${it.key}`) }) },
  dropStash: (c: Any, it: Any) => { c.ui.dialog = confirmDialog('Drop stash', `Drop ${it.s.ref}: ${it.s.message}?`, { label: 'Drop', run: (cc: Any) => cc.m('stashDrop', { index: it.s.index }, `git stash drop ${it.s.ref}`) }) },
  reset: (c: Any, it: Any, mode: string) => { c.ui.dialog = confirmDialog(`Reset (${mode})`, `Reset ${c.branch ?? 'HEAD'} to ${it.c.shortHash} (${mode})?`, { label: `Reset ${mode}`, run: (cc: Any) => cc.m('reset', { ref: it.key, mode }, `git reset --${mode} ${it.c.shortHash}`) }) },
  worktreeNew(c: Any) {
    const clean = String(c.branch ?? 'wt').replace(/[^\w.-]+/g, '-')
    c.ui.dialog = promptDialog('New worktree', [
      { name: 'path', label: 'Absolute path', value: `${c.props.dir}-${clean}` },
      { name: 'branch', label: 'Branch (existing or new)', value: '' },
      { name: 'start', label: 'Start point (optional)', value: '' },
    ], [{ name: 'createBranch', label: 'Create branch', on: true }, { name: 'detached', label: 'Detached HEAD', on: false }], 'Create',
      (cc: Any, v: Any, f: Any) => cc.m('addWorktree', { path: v.path, branch: v.branch, createBranch: f.createBranch, detached: f.detached, start: v.start }, `git worktree add ${v.path}`))
  },
  worktreeMove: (c: Any, it: Any) => { c.ui.dialog = promptDialog('Move worktree', [{ name: 'to', label: 'New absolute path', value: it.w.path }], [], 'Move', (cc: Any, v: Any) => cc.m('moveWorktree', { from: it.w.path, to: v.to }, `git worktree move ${it.w.path}`)) },
  worktreeLock: (c: Any, it: Any) => { c.ui.dialog = promptDialog('Lock worktree', [{ name: 'reason', label: 'Reason (optional)', value: '' }], [], 'Lock', (cc: Any, v: Any) => cc.m('lockWorktree', { path: it.w.path, reason: v.reason }, `git worktree lock ${it.w.path}`)) },
  worktreeRemove: (c: Any, it: Any) => { c.ui.dialog = confirmDialog('Remove worktree', `Remove ${it.w.path}?`, { label: 'Remove', run: (cc: Any, f: Any) => cc.m('removeWorktree', { path: it.w.path, force: f.force }, `git worktree remove ${it.w.path}`) }, [{ name: 'force', label: 'Force (uncommitted work)', on: false }]) },
  sendToChat(c: Any, text: string, head: string) { c.req('sendToChat', { text: `${head}:\n\`\`\`diff\n${text.slice(0, 20000)}\n\`\`\`\n` }, 'quiet') },
  applyLines(c: Any, it: Any, patch: string, lines: number[]) {
    if (lines.length === 0) return
    c.m('stageLines', { path: it.path, staged: it.group === 'staged', patch, lines }, `${it.group === 'staged' ? 'unstage' : 'stage'} ${lines.length} line(s) of ${it.path}`)
    c.ui.lines = []
  },
}

// ---------------------------------------------------------------- pieces

function Chip(c: Any, text: string, color: string) {
  const { Text } = c.E
  return <Text color={color} size="footnote" weight="semibold" mono>{text}</Text>
}

function Cell(c: Any, label: string, body: Any, grow = false) {
  const { Box, Text } = c.E
  return (
    <Box flexDirection="column" paddingX={2} paddingY={1} borderStyle="round" borderColor="promptBorder" backgroundColor={SURFACE} flexGrow={grow ? 1 : undefined}>
      <Text color="subtle" size="caption">{label}</Text>
      {body}
    </Box>
  )
}

function Header(c: Any) {
  const { Box, Text, Button } = c.E
  const { ui, props, snap } = c
  const b = snap.status?.branch ?? {}
  const repoName = String(props.dir ?? '').split('/').filter(Boolean).at(-1) ?? 'Git'
  const prog = Object.entries(snap.status?.inProgress ?? {}).filter(([, v]) => v === true).map(([k]) => k)
  const behind = b.behind ?? 0
  const ahead = b.ahead ?? 0
  const sync = behind > 0 ? { label: `Pull origin  ↓${behind}`, hint: `Last fetched ${ago(ui.fetchedAt)}`, run: () => c.m('pull', {}, 'git pull'), main: false }
    : ahead > 0 || !b.upstream ? { label: b.upstream ? `Push origin  ↑${ahead}` : 'Publish branch', hint: `Last fetched ${ago(ui.fetchedAt)}`, run: () => A.push(c), main: true }
    : { label: 'Fetch origin', hint: `Last fetched ${ago(ui.fetchedAt)}`, run: () => c.m('fetch', {}, 'git fetch --all --prune'), main: false }
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" alignItems="stretch" gap={1} flexWrap="wrap">
        {Cell(c, 'Current repository', <Button key="repo" plain onPress={() => { A.repo(c); c.redraw() }}><Text weight="semibold">{`${repoName}  ▾`}</Text></Button>, true)}
        {Cell(c, 'Current branch', <Button key="branch" plain hotkey="3" onPress={() => { ui.tab = 'branches'; ui.sel = null; ui.detail = null; ui.detailKey = ''; initSelection(c); c.redraw() }}><Text weight="semibold" color="claude">{`⎇ ${b.name ?? `(${b.shortOid ?? 'no branch'})`}  ▾`}</Text></Button>, true)}
        {Cell(c, sync.hint, <Button key="sync" variant={sync.main ? 'primary' : 'secondary'} hotkey="p" onPress={sync.run}>{sync.label}</Button>, true)}
      </Box>
      <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
        <Button key="fetch" plain dimColor hotkey="f" onPress={() => c.m('fetch', {}, 'git fetch --all --prune')}>Fetch</Button>
        <Button key="pull" plain dimColor hotkey="l" onPress={() => c.m('pull', {}, 'git pull')}>Pull</Button>
        <Button key="undo" plain dimColor hotkey="u" onPress={() => { A.undo(c); c.redraw() }}>Undo</Button>
        <Button key="refresh" plain dimColor hotkey="r" onPress={() => c.req('refresh', {}, 'quiet')}>Refresh</Button>
        {props.busy ? <Text color="warning" size="footnote">working…</Text> : null}
      </Box>
      {prog.length > 0 ? (
        <Box flexDirection="row" alignItems="center" gap={2} borderStyle="round" borderColor="warning" paddingX={1}>
          <Text color="warning" weight="semibold">{`${prog.join(', ')} in progress`}</Text>
          <Button key="abort" variant="secondary" onPress={() => c.m('abortOperation', { kind: prog[0] }, `abort ${prog[0]}`)}>Abort</Button>
        </Box>
      ) : null}
    </Box>
  )
}

function Tabs(c: Any) {
  const { Box, Button } = c.E
  const { ui, snap } = c
  const go = (id: string) => { ui.tab = id; ui.sel = null; ui.detail = null; ui.detailKey = ''; ui.lines = []; initSelection(c); c.redraw() }
  const nFiles = snap.status?.files?.length ?? 0
  return (
    <Box flexDirection="row" gap={1}>
      <Button key="tab-changes" variant={ui.tab === 'changes' ? 'primary' : 'secondary'} hotkey="1" onPress={() => go('changes')}>{nFiles > 0 ? `Changes  ${nFiles}` : 'Changes'}</Button>
      <Button key="tab-history" variant={ui.tab === 'history' ? 'primary' : 'secondary'} hotkey="2" onPress={() => go('history')}>History</Button>
      {ui.tab === 'branches' ? <Button key="tab-branches" variant="primary" onPress={() => go('branches')}>Branches</Button> : null}
      {ui.tab === 'stash' ? <Button key="tab-stash" variant="primary" onPress={() => go('stash')}>Stashed changes</Button> : null}
    </Box>
  )
}

function initSelection(c: Any) {
  const { ui, snap } = c
  if (ui.tab === 'changes') ui.sel = flatFiles(snap, ui)[0] ?? null
  else ui.sel = listFor(ui, snap)[0] ?? null
  loadDetail(c, true)
}

function Row(c: Any, item: Any, left: Any[], right: Any = null) {
  const { Box, Text, Button } = c.E
  const on = itemKey(c.ui.sel) === itemKey(item)
  return (
    <Box key={`row-${itemKey(item)}`} flexDirection="row" alignItems="center" gap={1} paddingX={1} backgroundColor={on ? 'promptBorder' : undefined}>
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <Button key={`sel-${itemKey(item)}`} plain onPress={() => selectItem(c, item)}><Text wrap="truncate-end">{left}</Text></Button>
      </Box>
      {right}
    </Box>
  )
}

function ChangesList(c: Any) {
  const { Box, Text, Button, Input } = c.E
  const { ui, snap } = c
  const files = flatFiles(snap, ui)
  const staged = files.filter((f) => f.staged)
  const all = ui.showAll.files === true
  const shown = all ? files : files.slice(0, 40)
  const allStaged = files.length > 0 && files.every((f) => f.staged && !f.unstaged)
  const someStaged = staged.length > 0
  const box = (f: Any) => (f.staged && !f.unstaged ? '☑' : f.staged ? '▣' : '☐')
  const rows: Any[] = shown.map((f: Any) => {
    const { name, dir } = splitPath(f.path)
    const l = f.group === 'staged' ? f.f.x : f.group === 'untracked' ? '?' : f.group === 'conflict' ? 'U' : f.f.y
    const on = itemKey(ui.sel) === itemKey(f)
    return (
      <Box key={`row-${f.path}`} flexDirection="row" alignItems="center" gap={1} paddingX={1} backgroundColor={on ? 'promptBorder' : undefined}>
        <Button key={`chk-${f.path}`} plain onPress={() => (f.staged && !f.unstaged ? A.unstage(c, [f.path]) : A.stage(c, [f.path]))}><Text color={f.staged ? 'claude' : 'subtle'} size="heading">{box(f)}</Text></Button>
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Button key={`sel-${f.path}`} plain onPress={() => selectItem(c, f)}>
            <Text wrap="truncate-end"><Text weight={on ? 'semibold' : 'medium'}>{name}</Text>{dir ? <Text color="subtle" size="footnote">{`  ${dir}`}</Text> : null}</Text>
          </Button>
        </Box>
        <Text color={STATUS_COLOR[l] ?? 'subtle'} weight="semibold">{STATUS_ICON[l] ?? '◼'}</Text>
      </Box>
    )
  })
  const n = files.length
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" backgroundColor={SURFACE} overflow="hidden">
        <Box flexDirection="row" alignItems="center" gap={1} paddingX={1} paddingY={1}>
          <Button key="chk-all" plain onPress={() => (allStaged ? A.unstage(c, [], 'unstage all') : A.stage(c, files.map((f: Any) => f.path), 'stage all'))}><Text color={someStaged ? 'claude' : 'subtle'} size="heading">{allStaged ? '☑' : someStaged ? '▣' : '☐'}</Text></Button>
          <Text weight="semibold">{n === 0 ? 'No changes' : `${n} changed file${n === 1 ? '' : 's'}`}</Text>
          <Box flexGrow={1} />
          {n > 0 ? <Button key="discard-all" plain dimColor onPress={() => { A.discardAll(c); c.redraw() }}>Discard all</Button> : null}
        </Box>
        {n === 0 ? <Box padding={2}><Text color="subtle">Working tree clean. Nothing to commit.</Text></Box> : <Box flexDirection="column">{rows}</Box>}
        {!all && files.length > 40 ? <Box paddingX={2} paddingY={1}><Button key="showall" plain dimColor onPress={() => { ui.showAll.files = true; c.redraw() }}>{`Show all ${files.length}`}</Button></Box> : null}
        <Box paddingX={1} paddingY={1}>
          <Button key="open-stash" plain dimColor hotkey="4" onPress={() => { ui.tab = 'stash'; ui.sel = null; ui.detailKey = ''; initSelection(c); c.redraw() }}>{`⧉ Stashed changes${(snap.stashes?.length ?? 0) > 0 ? `  ${snap.stashes.length}` : ''}  ›`}</Button>
        </Box>
      </Box>
      <Box flexDirection="column" gap={1} borderStyle="round" borderColor="promptBorder" backgroundColor={SURFACE} padding={1}>
        <Input key={`sum-${ui.commitN}`} placeholder="Summary (required)" value={ui.sum} onInput={(v: string) => { ui.sum = v }} onSubmit={(v: string) => { ui.sum = v; A.commit(c) }} />
        <Input key={`desc-${ui.commitN}`} placeholder="Description" value={ui.desc} rows={4} onInput={(v: string) => { ui.desc = v }} onSubmit={(v: string) => { ui.desc = v }} />
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Button key="amend" plain dimColor onPress={() => { ui.amend = !ui.amend; if (ui.amend) c.req('lastCommitMessage', {}, 'amendMsg'); c.redraw() }}>{ui.amend ? '☑ Amend previous commit' : '☐ Amend previous commit'}</Button>
          <Box flexGrow={1} />
          <Button key="stash" plain dimColor onPress={() => { A.stashNew(c); c.redraw() }}>Stash…</Button>
        </Box>
        <Button key="commit" variant="primary" hotkey="c" onPress={() => A.commit(c)}>{`${ui.amend ? 'Amend' : 'Commit'}${staged.length ? ` ${staged.length} file${staged.length === 1 ? '' : 's'}` : ''} to ${c.branch ?? 'HEAD'}`}</Button>
        <Text color="subtle" size="caption">Commit hooks are skipped in this pane.</Text>
      </Box>
    </Box>
  )
}

function ListTab(c: Any) {
  const { Box, Text, Button } = c.E
  const { ui, snap } = c
  const list = listFor(ui, snap)
  const rows: Any[] = []
  if (list.length === 0) rows.push(<Box key="empty" padding={2}><Text color="subtle">{ui.tab === 'stash' ? 'No stashes.' : 'Nothing here.'}</Text></Box>)
  for (const it of list) {
    if (it.kind === 'commit') {
      const deco = String(it.c.decorations ?? '').replace(/^\s*\(|\)\s*$/g, '')
      rows.push(Row(c, it, [
        <Text key="s" color="subtle" mono size="footnote">{it.c.shortHash}</Text>,
        <Text key="m" weight="medium"> {it.c.subject}</Text>,
        <Text key="a" color="subtle" size="footnote">{`  ${it.c.author} · ${it.c.date}`}</Text>,
        deco ? <Text key="d" color="claude" size="footnote">{`  ${deco}`}</Text> : null,
      ]))
    } else if (it.kind === 'stash') rows.push(Row(c, it, [<Text key="r" color="subtle" mono size="footnote">{it.s.ref}</Text>, <Text key="m" weight="medium"> {it.s.message}</Text>, <Text key="d" color="subtle" size="footnote">{`  ${it.s.date}`}</Text>]))
    else if (it.kind === 'local') rows.push(Row(c, it, [<Text key="c" color="success" weight="semibold">{it.b.current ? '● ' : '  '}</Text>, <Text key="n" weight={it.b.current ? 'semibold' : 'medium'}>{it.b.name}</Text>, it.b.upstream ? <Text key="u" color="subtle" size="footnote">{`  ↔ ${it.b.upstream}`}</Text> : null, <Text key="d" color="subtle" size="footnote">{`  ${it.b.date}`}</Text>]))
    else if (it.kind === 'remote') rows.push(Row(c, it, [<Text key="n" weight="medium">{it.b.name}</Text>, <Text key="d" color="subtle" size="footnote">{`  ${it.b.date}`}</Text>]))
    else if (it.kind === 'tag') rows.push(Row(c, it, [<Text key="n" weight="medium">{it.t.name}</Text>, <Text key="d" color="subtle" size="footnote">{`  ${it.t.date}`}</Text>]))
    else if (it.kind === 'worktree') {
      const flags = [it.w.main ? 'main' : '', it.w.isCurrent ? 'current' : '', it.w.locked ? 'locked' : '', it.w.prunable ? 'stale' : ''].filter(Boolean).join(' · ')
      rows.push(Row(c, it, [<Text key="b" weight="semibold">{it.w.branch ?? '(detached)'}</Text>, <Text key="p" color="subtle" size="footnote">{`  ${it.w.path}`}</Text>, flags ? <Text key="f" color="warning" size="footnote">{`  ${flags}`}</Text> : null]))
    } else rows.push(Row(c, it, [<Text key="s" color="subtle" mono size="footnote">{it.r.selector}</Text>, <Text key="m"> {it.r.subject}</Text>]))
  }
  return (
    <Box flexDirection="column" gap={1}>
      {ui.tab === 'branches' ? (
        <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
          {SUBS.map((s, i) => <Button key={`sub-${i}`} variant={ui.sub === i ? 'primary' : 'secondary'} onPress={() => { ui.sub = i; ui.sel = listFor(ui, snap)[0] ?? null; loadDetail(c, true); c.redraw() }}>{s}</Button>)}
          <Box flexGrow={1} />
          <Button key="new-branch" plain dimColor onPress={() => { A.branchNew(c); c.redraw() }}>New branch…</Button>
          <Button key="new-wt" plain dimColor onPress={() => { A.worktreeNew(c); c.redraw() }}>New worktree…</Button>
          <Button key="prune" plain dimColor onPress={() => c.req('pruneWorktrees', { dryRun: true }, 'pruneDry')}>Prune</Button>
        </Box>
      ) : null}
      <Box flexDirection="column">{rows}</Box>
      {ui.tab === 'history' && (snap.hasMore && ui.more === null || ui.hasMore) ? (
        <Box paddingX={1}><Button key="load-more" variant="secondary" onPress={() => c.req('log', { limit: 50, skip: (snap.commits?.length ?? 0) + (ui.more?.length ?? 0) }, 'more')}>Load more</Button></Box>
      ) : null}
      {ui.tab === 'stash' ? <Box paddingX={1}><Button key="stash-new" variant="secondary" onPress={() => { A.stashNew(c); c.redraw() }}>Stash changes…</Button></Box> : null}
    </Box>
  )
}

const pad = (n: number | string, w = 4) => String(n).padStart(w, ' ')

// One unified patch -> rows with old/new line-number gutters, like GitHub Desktop.
function PatchRows(c: Any, patch: string, opts: { selectable: boolean; it?: Any; keyp: string; max: number }): Any[] {
  const { Box, Text, Button } = c.E
  const raw = patch.split('\n')
  const out: Any[] = []
  let oldN = 0
  let newN = 0
  let shown = 0
  raw.forEach((l, idx) => {
    if (l.startsWith('@@ ')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l)
      oldN = m ? Number(m[1]) : 0
      newN = m ? Number(m[2]) : 0
      if (shown > opts.max) return
      out.push(
        <Box key={`${opts.keyp}-hh-${idx}`} flexDirection="row" alignItems="center" gap={2} paddingX={1} backgroundColor={HUNK_BG}>
          <Text color="subtle" mono size="footnote" wrap="truncate-end">{l}</Text>
          <Box flexGrow={1} />
          {opts.selectable ? <Button key={`${opts.keyp}-hunk-${idx}`} plain dimColor onPress={() => A.applyLines(c, opts.it, patch, hunkOf(patch, idx + 1))}>{opts.it.group === 'staged' ? 'Unstage hunk' : 'Stage hunk'}</Button> : null}
        </Box>,
      )
      return
    }
    if (oldN === 0 && newN === 0) return
    if (l.startsWith('\\')) return
    const add = l[0] === '+'
    const del = l[0] === '-'
    const o = add ? '' : String(oldN)
    const n = del ? '' : String(newN)
    if (!add) oldN += 1
    if (!del) newN += 1
    shown += 1
    if (shown > opts.max) return
    const picked = c.ui.lines.includes(idx)
    const text = `${pad(o)} ${pad(n)}  ${add ? '+' : del ? '−' : ' '} ${l.slice(1)}`
    const node = <Text mono size="footnote" color="text" backgroundColor={picked ? 'rgba(56,139,253,0.35)' : add ? ADD_BG : del ? DEL_BG : undefined} wrap="wrap">{text}</Text>
    const gutter = (add || del) && opts.selectable
      ? <Button key={`${opts.keyp}-pick-${idx}`} plain onPress={() => { const s = new Set<number>(c.ui.lines); if (s.has(idx)) s.delete(idx); else s.add(idx); c.ui.lines = [...s].sort((a, b) => a - b); c.redraw() }}><Text color={picked ? 'claude' : 'subtle'} mono>{picked ? '☑' : '☐'}</Text></Button>
      : <Text mono> </Text>
    out.push(
      <Box key={`${opts.keyp}-dl-${idx}`} flexDirection="row" alignItems="center" gap={1}>
        <Box width={3}>{gutter}</Box>
        <Box flexGrow={1}>{node}</Box>
      </Box>,
    )
  })
  return out
}

function FileBar(c: Any, path: string, right: Any = null) {
  const { Box, Text } = c.E
  const { name, dir } = splitPath(path)
  return (
    <Box flexDirection="row" alignItems="center" gap={2} paddingX={1} paddingY={1} backgroundColor={SURFACE}>
      <Text wrap="truncate-start"><Text color="subtle">{dir}</Text><Text weight="semibold">{name}</Text></Text>
      <Box flexGrow={1} />
      {right}
    </Box>
  )
}

function DiffView(c: Any, d: Any, it: Any) {
  const { Box, Text, Button } = c.E
  const patch: string = d.patch ?? ''
  const staged = it.group === 'staged'
  const selectable = it.group !== 'untracked' && !d.binary
  const raw = patch.split('\n')
  let adds = 0
  let dels = 0
  raw.forEach((l) => { if (l.startsWith('+') && !l.startsWith('+++')) adds += 1; else if (l.startsWith('-') && !l.startsWith('---')) dels += 1 })
  const max = c.ui.showAll[`diff:${it.path}`] ? 100000 : 400
  const toggle = it.staged && it.unstaged ? (
    <Box flexDirection="row" gap={1}>
      <Button key="v-unstaged" variant={staged ? 'secondary' : 'primary'} onPress={() => { c.ui.fileView[it.path] = 'unstaged'; c.ui.sel = { ...it, group: 'unstaged' }; loadDetail(c, true); c.redraw() }}>Unstaged</Button>
      <Button key="v-staged" variant={staged ? 'primary' : 'secondary'} onPress={() => { c.ui.fileView[it.path] = 'staged'; c.ui.sel = { ...it, group: 'staged' }; loadDetail(c, true); c.redraw() }}>Staged</Button>
    </Box>
  ) : null
  return (
    <Box flexDirection="column" gap={1}>
      {FileBar(c, it.path, <Box flexDirection="row" alignItems="center" gap={1}>
        <Text color="success" size="footnote" mono>{`+${adds}`}</Text><Text color="error" size="footnote" mono>{`−${dels}`}</Text>
        {toggle}
        {it.group !== 'staged' ? <Button key="discard" plain dimColor onPress={() => { A.discard(c, it); c.redraw() }}>Discard</Button> : null}
        {d.patch ? <Button key="send" plain dimColor onPress={() => { A.sendToChat(c, d.patch, `${it.group} diff of ${it.path}`); c.redraw() }}>Send to chat</Button> : null}
      </Box>)}
      {d.binary ? <Box padding={2}><Text color="subtle">Binary file: no textual diff.</Text></Box> : d.empty ? <Box padding={2}><Text color="subtle">No changes.</Text></Box> : null}
      {!d.binary && !d.empty ? <Box flexDirection="column" borderStyle="round" borderColor="promptBorder">{PatchRows(c, patch, { selectable, it, keyp: 'd', max })}</Box> : null}
      {!d.binary && !d.empty ? <Text color="subtle" size="caption">{selectable ? 'Click changed lines to select them, or use Stage hunk.' : 'New file: stage it as a whole with its checkbox.'}</Text> : null}
      {raw.length > max ? <Button key="diff-more" variant="secondary" onPress={() => { c.ui.showAll[`diff:${it.path}`] = true; c.redraw() }}>Show the rest of the diff</Button> : null}
      {d.truncated ? <Text color="warning" size="footnote">{`Diff cut: ${d.truncated} more characters not shown.`}</Text> : null}
      {c.ui.lines.length > 0 ? (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Button key="apply-lines" variant="primary" onPress={() => A.applyLines(c, it, patch, c.ui.lines)}>{`${staged ? 'Unstage' : 'Stage'} ${c.ui.lines.length} selected line${c.ui.lines.length === 1 ? '' : 's'}`}</Button>
          <Button key="clear-lines" plain dimColor onPress={() => { c.ui.lines = []; c.redraw() }}>Clear selection</Button>
        </Box>
      ) : null}
    </Box>
  )
}

function ImageView(c: Any) {
  const { Box, Text, Svg } = c.E
  const img = c.props.image
  if (!img) return <Text color="subtle">Loading preview…</Text>
  const w = 260
  const ih = 200
  const one = (label: string, side: Any) => {
    if (side === null || side === undefined) return <Box key={label} flexDirection="column" gap={1}><Text color="subtle" size="footnote">{label}</Text><Text color="subtle">(none)</Text></Box>
    if (side.tooLarge || !side.dataUrl || side.dataUrl.length > 120000) return <Box key={label} flexDirection="column" gap={1}><Text color="subtle" size="footnote">{label}</Text><Text color="warning">{`Too large to preview (${side.bytes} bytes)`}</Text></Box>
    const source = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${ih}' viewBox='0 0 ${w} ${ih}'><defs><pattern id='c' width='16' height='16' patternUnits='userSpaceOnUse'><rect width='16' height='16' fill='#d8d8d8'/><rect width='8' height='8' fill='#f4f4f4'/><rect x='8' y='8' width='8' height='8' fill='#f4f4f4'/></pattern></defs><rect width='${w}' height='${ih}' rx='8' fill='url(#c)'/><image href='${side.dataUrl}' x='0' y='0' width='${w}' height='${ih}' preserveAspectRatio='xMidYMid meet'/></svg>`
    return (
      <Box key={label} flexDirection="column" gap={1}>
        <Text color="subtle" size="footnote">{`${label}  ·  ${side.bytes} bytes`}</Text>
        <Svg source={source} alt={`${label} image`} width={w} height={ih} />
      </Box>
    )
  }
  return <Box flexDirection="row" gap={3} flexWrap="wrap">{one('Before', img.before)}{one('After', img.after)}</Box>
}

function ShowView(c: Any, d: Any, it: Any) {
  const { Box, Text } = c.E
  const body = String(d.body ?? '').trim()
  const parts = String(d.patch ?? '').split(/^(?=diff --git )/m).filter((x) => x.startsWith('diff --git '))
  return (
    <Box flexDirection="column" gap={2}>
      <Box flexDirection="column" gap={1} paddingX={1}>
        <Text weight="semibold" size="heading">{d.subject}</Text>
        {body ? <Text>{body}</Text> : null}
        <Text color="subtle" size="footnote">{`${d.author} <${d.email}>  ·  ${d.date}  ·  ${String(d.hash ?? '').slice(0, 10)}`}</Text>
      </Box>
      <Text color="subtle" size="footnote">{`${parts.length} changed file${parts.length === 1 ? '' : 's'}`}</Text>
      {parts.slice(0, 40).map((chunk, i) => {
        const m = /^diff --git a\/(.+) b\/(.+)$/m.exec(chunk)
        const path = m ? m[2]! : `file ${i + 1}`
        return (
          <Box key={`f-${i}`} flexDirection="column" borderStyle="round" borderColor="promptBorder">
            {FileBar(c, path)}
            {PatchRows(c, chunk, { selectable: false, keyp: `s${i}`, max: 250 })}
          </Box>
        )
      })}
    </Box>
  )
}

function Actions(c: Any, it: Any, d: Any) {
  const { Box, Button } = c.E
  const redraw = (fn: () => void) => () => { fn(); c.redraw() }
  const out: Any[] = []
  const add = (label: string, fn: () => void, variant = 'secondary') => out.push(<Button key={`a-${label}`} variant={variant} onPress={redraw(fn)}>{label}</Button>)
  if (it.kind === 'file') {
  } else if (it.kind === 'commit') {
    add('Checkout', () => c.m('checkout', { ref: it.key }, `git checkout ${it.c.shortHash}`), 'primary')
    add('Cherry-pick', () => c.m('cherryPick', { hash: it.key }, `git cherry-pick ${it.c.shortHash}`))
    add('Revert', () => c.m('revert', { hash: it.key }, `git revert ${it.c.shortHash}`))
    add('Reset soft', () => A.reset(c, it, 'soft')); add('Reset mixed', () => A.reset(c, it, 'mixed')); add('Reset hard', () => A.reset(c, it, 'hard'))
    add('Tag…', () => A.tagNew(c, it)); add('Copy hash', () => c.req('copy', { text: it.key }, 'quiet'))
    if (d?.patch) add('Send to chat', () => A.sendToChat(c, d.patch, `commit ${it.c.shortHash} ${it.c.subject}`))
  } else if (it.kind === 'stash') {
    add('Apply', () => c.m('stashApply', { index: it.s.index }, `git stash apply ${it.s.ref}`), 'primary')
    add('Pop', () => c.m('stashPop', { index: it.s.index }, `git stash pop ${it.s.ref}`)); add('Drop…', () => A.dropStash(c, it))
    if (d?.patch) add('Send to chat', () => A.sendToChat(c, d.patch, `stash ${it.s.ref}`))
  } else if (it.kind === 'local' || it.kind === 'remote') {
    add('Checkout', () => c.m('checkout', { ref: it.key }, `git checkout ${it.key}`), 'primary')
    add('Merge into current…', () => A.merge(c, it)); add('Rebase onto…', () => A.rebase(c, it))
    if (it.kind === 'local') { add('Rename…', () => A.rename(c, it)); add('Delete…', () => A.deleteBranch(c, it)) }
  } else if (it.kind === 'tag') {
    add('Checkout', () => c.m('checkout', { ref: it.key }, `git checkout ${it.key}`), 'primary'); add('Delete…', () => A.deleteTag(c, it))
  } else if (it.kind === 'worktree') {
    add('Open here', () => c.req('setDir', { dir: it.w.path }, 'quiet'), 'primary')
    add('Move…', () => A.worktreeMove(c, it))
    if (it.w.locked) add('Unlock', () => c.m('unlockWorktree', { path: it.w.path }, `git worktree unlock ${it.w.path}`)); else add('Lock…', () => A.worktreeLock(c, it))
    add('Remove…', () => A.worktreeRemove(c, it))
  }
  return out.length === 0 ? null : <Box flexDirection="row" gap={1} flexWrap="wrap">{out}</Box>
}

function Detail(c: Any) {
  const { Box, Text } = c.E
  const { ui } = c
  const it = ui.sel
  const d = ui.detail
  if (it === null || it === undefined) return <Box padding={3}><Text color="subtle">Select an item to see its details.</Text></Box>
  let title = ''
  let sub = ''
  if (it.kind === 'file') { title = it.path }
  else if (it.kind === 'commit') title = it.c.subject
  else if (it.kind === 'stash') title = `${it.s.ref}  ${it.s.message}`
  else if (it.kind === 'local' || it.kind === 'remote') title = it.key
  else if (it.kind === 'tag') title = it.key
  else if (it.kind === 'worktree') { title = it.w.branch ?? '(detached)'; sub = it.w.path }
  else title = it.r.selector
  let body: Any = <Text color="subtle">Loading…</Text>
  if (d?.error) body = <Text color="error">{d.error}</Text>
  else if (it.kind === 'file' && IMAGE.test(it.path)) return <Box flexDirection="column" gap={1}>{FileBar(c, it.path)}<Box padding={2}>{ImageView(c)}</Box></Box>
  else if (it.kind === 'file' && d?.patch !== undefined) return <Box flexDirection="column" gap={1}>{DiffView(c, d, it)}</Box>
  else if ((it.kind === 'commit' || it.kind === 'stash' || it.kind === 'tag' || it.kind === 'reflog') && d?.subject !== undefined) body = ShowView(c, d, it)
  else if (d?.commits) body = <Box flexDirection="column">{d.commits.map((x: Any) => <Text key={x.hash} size="footnote"><Text color="subtle" mono>{x.shortHash}</Text>{`  ${x.subject}  ·  ${x.author}, ${x.date}`}</Text>)}</Box>
  else if (it.kind === 'worktree') body = <Text color="subtle">{`${it.w.locked ? 'Locked' + (it.w.lockReason ? ': ' + it.w.lockReason : '') + '. ' : ''}${it.w.prunable ? 'Stale: ' + it.w.prunableReason : ''}`}</Text>
  return (
    <Box flexDirection="column" gap={2}>
      <Box flexDirection="column">
        {it.kind !== 'commit' ? <Text weight="semibold" size="heading" wrap="truncate-end">{title}</Text> : null}
        {sub ? <Text color="subtle" size="footnote" wrap="truncate-end">{sub}</Text> : null}
      </Box>
      {Actions(c, it, d)}
      {body}
    </Box>
  )
}

function Dialog(c: Any) {
  const { Box, Text, Button, Input } = c.E
  const { ui } = c
  const d = ui.dialog
  const close = () => { ui.dialog = null; c.redraw() }
  const submit = () => { const v = fieldValues(d); const f = flagValues(d); const run = d.submit?.run; ui.dialog = null; if (run) run(c, v, f); c.redraw() }
  const kids: Any[] = []
  if (d.message) kids.push(<Text key="msg" wrap="wrap">{d.message}</Text>)
  if (d.hint) kids.push(<Text key="hint" color="subtle" size="footnote">{d.hint}</Text>)
  d.fields.forEach((f: Any, i: number) => kids.push(
    <Input key={`f${i}`} label={f.label} value={f.value} placeholder={f.placeholder} autoFocus={i === 0 ? true : undefined}
      onInput={(v: string) => { f.value = v }} onSubmit={(v: string) => { f.value = v; submit() }} />))
  d.flags.forEach((f: Any, i: number) => kids.push(<Button key={`g${i}`} variant="secondary" onPress={() => { f.on = !f.on; c.redraw() }}>{`${f.on ? '☑' : '☐'} ${f.label}`}</Button>))
  for (const [i, r] of (d.recents ?? []).slice(0, 6).entries()) kids.push(<Button key={`r${i}`} plain onPress={() => { ui.dialog = null; c.req('setDir', { dir: r }, 'quiet'); c.redraw() }}><Text size="footnote" color="subtle">{r}</Text></Button>)
  if (d.init) kids.push(<Button key="init" variant="secondary" onPress={() => { ui.dialog = null; c.m('initRepo', {}, 'git init'); c.redraw() }}>Initialize a repository here</Button>)
  const row: Any[] = []
  if (d.confirm) row.push(<Button key="ok" variant="primary" onPress={() => { const run = d.confirm.run; const f = flagValues(d); ui.dialog = null; run(c, f); c.redraw() }}>{d.confirm.label}</Button>)
  if (d.submit) row.push(<Button key="go" variant="primary" onPress={submit}>{d.submit.label}</Button>)
  row.push(<Button key="cancel" variant="secondary" onPress={close}>Cancel</Button>)
  return (
    <Box flexDirection="column" gap={1} borderStyle="round" borderColor="claude" padding={1}>
      <Text weight="semibold" size="heading">{d.title}</Text>
      {kids}
      <Box flexDirection="row" gap={1}>{row}</Box>
    </Box>
  )
}

function Activity(c: Any) {
  const { Box, Text, Button } = c.E
  const { ui } = c
  const last = ui.log.slice(-6).reverse()
  return (
    <Box flexDirection="column" gap={1}>
      <Button key="log-toggle" plain dimColor onPress={() => { ui.logOpen = !ui.logOpen; c.redraw() }}>{`${ui.logOpen ? '▾' : '▸'} Activity${ui.log.length ? `  ${ui.log.length}` : ''}`}</Button>
      {ui.logOpen ? <Box flexDirection="column" paddingX={1}>{last.length === 0 ? <Text color="subtle" size="footnote">No commands yet.</Text> : last.map((e: Any, i: number) => <Text key={`lg-${i}`} size="footnote" mono color={e.ok ? 'subtle' : 'error'}>{`${e.ok ? '✓' : '✗'} ${e.t}  ${e.text}${e.ok ? '' : '  ' + e.err}`}</Text>)}</Box> : null}
    </Box>
  )
}

// ---------------------------------------------------------------- entry

export function GitView(E: Any, props: Any, ui: Any, act: Any) {
  const { Box, Text, Button } = E
  const snap = props.snap ?? {}
  const c: Any = { E, props, ui, snap, branch: snap.status?.branch?.name ?? null, req: act.req, redraw: act.redraw }
  c.m = (method: string, request: Any = {}, label = '') => act.req(method, request, 'm', label || method)

  if (props.dir === '' || props.dir === undefined || snap.status === undefined) {
    return <Box padding={3}><Text color="subtle">{props.error ? props.error : 'Loading…'}</Text></Box>
  }
  if (snap.status.isRepo === false) {
    return (
      <Box flexDirection="column" padding={3} gap={2}>
        <Text weight="semibold" size="heading">Not a git repository</Text>
        <Text color="subtle">{props.dir}</Text>
        <Text>This folder has no repository yet. Initialize one to start tracking changes, or open another folder.</Text>
        <Box flexDirection="row" gap={1}>
          <Button key="init" variant="primary" onPress={() => c.m('initRepo', {}, 'git init')}>Initialize repository</Button>
          <Button key="choose" variant="secondary" onPress={() => { A.repo(c); c.redraw() }}>Open another folder</Button>
        </Box>
        {ui.dialog ? Dialog(c) : null}
      </Box>
    )
  }
  if (props.rev !== ui.rev) {
    ui.rev = props.rev
    ui.more = null
    ui.hasMore = false
    if (ui.sel === null || ui.sel === undefined) initSelection(c)
    else {
      // keep the selection when it still exists, else fall back to the first item
      const exists = (ui.tab === 'changes' ? flatFiles(snap, ui) : listFor(ui, snap)).find((x: Any) => itemKey(x) === itemKey(ui.sel))
      if (exists) ui.sel = exists
      else initSelection(c)
      loadDetail(c, true)
    }
  } else if (ui.sel === null && ui.detail === null) initSelection(c)

  return (
    <Box flexDirection="column" gap={2} padding={2}>
      {Header(c)}
      {Tabs(c)}
      {ui.notice ? (
        <Box flexDirection="row" alignItems="center" gap={2} borderStyle="round" borderColor="error" paddingX={1}>
          <Text color="error" wrap="wrap">{ui.notice}</Text>
          <Box flexGrow={1} />
          <Button key="dismiss" plain dimColor onPress={() => { ui.notice = ''; c.redraw() }}>Dismiss</Button>
        </Box>
      ) : null}
      {ui.dialog ? Dialog(c) : null}
      <Box flexDirection="row" gap={2} alignItems="flex-start">
        <Box flexDirection="column" width="38%" gap={1} overflow="hidden">{ui.tab === 'changes' ? ChangesList(c) : ListTab(c)}</Box>
        <Box flexDirection="column" flexGrow={1}>{Detail(c)}</Box>
      </Box>
      {Activity(c)}
    </Box>
  )
}
