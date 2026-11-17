// Native Claude Desktop view of the Git pane, drawn by the hooks module with the
// desktop element table (no Client grid). `E` is `$.ui.resolve(e)`; `act` reaches
// git through register.tsx.
type Any = any

const IMAGE = /\.(png|jpe?g|gif|webp|bmp|ico|avif|svg)$/i
const SURFACE = 'rgba(127,127,127,0.09)'
const HUNK_BG = 'rgba(56,139,253,0.14)'
const ADD_BG = 'rgba(46,160,67,0.28)'
const DEL_BG = 'rgba(248,81,73,0.28)'
const STATUS_WORD: Any = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Conflict', '?': 'New', T: 'Type' }
const STATUS_COLOR: Any = { M: 'warning', A: 'success', D: 'error', R: 'suggestion', C: 'suggestion', U: 'error', '?': 'success', T: 'warning' }
const STATUS_ICON: Any = { M: '◼', A: '✚', D: '━', R: '➜', C: '➜', U: '!', '?': '✚', T: '◼' }
const LIMIT = 14
const SEL_BG = '#0a64d8'
const SEL_FG = '#ffffff'
const YELLOW = '#e5b80b'
const BADGE_BG = '#ececf0'
const BADGE_FG = '#1c1c1e'
const TAG_BG = '#ffe28a'
const TAG_FG = '#5c4300'
const BADGE_STATUS: Any = { '?': '#3fb950', M: '#f5c542', A: '#3fb950', D: '#f85149', R: '#58a6ff', C: '#58a6ff', T: '#f5c542', U: '#f85149' }
const STATUS_GLYPH: Any = { '?': '+', M: '⋯', A: '+', D: '−', R: '➜', C: '➜', T: '⋯', U: '!' }
const LANE_COLORS = ['#e5b80b', '#ef5350', '#3fb950', '#4c9aff', '#bf5af2', '#ff8c42', '#2ec4b6', '#f06292']
const ROW_H = 28
const LANE_W = 12
const MAX_LANES = 8
const AVATAR = ['#5e5ce6', '#bf5af2', '#c77700', '#1f8a9e', '#d6285a', '#2478b8', '#1f9d46']

export function initUi(): Any {
  return {
    tab: 'changes', sub: 0, sel: null, detail: null, detailKey: '', lines: [], ctab: 'commit', sidebar: true, open: {}, rows: {}, sum: '', desc: '', commitN: 0, amend: false, fileView: {}, fetchedAt: 0, filter: '',
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
    if (tag.startsWith('detail:') && sameItem(tag.slice(7), ui.detailKey)) ui.detail = { key: tag.slice(7), error: `Could not load this diff: ${ui.notice}` }
    if (tag === '' || tag === 'm') ui.log.push({ t: stamp, text: reply.label || reply.method, ok: false, err: ui.notice })
    return
  }
  if (tag.startsWith('detail:')) {
    if (sameItem(tag.slice(7), ui.detailKey)) ui.detail = { key: tag.slice(7), ...(reply.data ?? {}) }
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

// A detail key is `item|group|rev`; a reply for the same item still counts after the rev moved on.
const sameItem = (a: string, b: string) => a.slice(0, a.lastIndexOf('|')) === b.slice(0, b.lastIndexOf('|'))

function loadDetail(c: Any, force = false) {
  const { ui, props } = c
  const it = ui.sel
  const key = `${itemKey(it)}|${it?.group ?? ''}|${props.rev}`
  if (!force && key === ui.detailKey) return
  const sameAsBefore = ui.detailKey !== '' && sameItem(key, ui.detailKey)
  ui.detailKey = key
  if (it === null || it === undefined) { ui.detail = null; return }
  if (!(sameAsBefore && ui.detail && ui.detail.kind !== 'loading' && !ui.detail.error)) ui.detail = { key, kind: 'loading' }
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



function RepoTabs(c: Any) {
  const { Box, Text, Button } = c.E
  const { props, snap } = c
  const cur = String(props.dir ?? '')
  const dirs: string[] = [cur, ...(props.recents ?? []).filter((r: string) => r !== cur)].filter(Boolean).slice(0, 6)
  const dirty = (snap.status?.files?.length ?? 0) > 0
  return (
    <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
      {dirs.map((d: string, i: number) => {
        const on = d === cur
        const name = d.split('/').filter(Boolean).at(-1) ?? d
        return (
          <Box key={`rt-${i}`} flexDirection="row" alignItems="center" gap={1} paddingX={2} backgroundColor={on ? SURFACE : undefined} borderStyle={on ? 'round' : undefined} borderColor="promptBorder">
            <Button key={`rtb-${i}`} plain dimColor={!on} onPress={() => { if (!on) c.req('setDir', { dir: d }, 'quiet') }}><Text weight={on ? 'semibold' : 'regular'}>{`${name}${on && dirty ? '*' : ''}`}</Text></Button>
            {on && dirty ? <Text color="error" size="footnote">●</Text> : null}
          </Box>
        )
      })}
      <Button key="rt-add" plain dimColor onPress={() => { A.repo(c); c.redraw() }}>+</Button>
    </Box>
  )
}

function Toolbar(c: Any) {
  const { Box, Text, Button } = c.E
  const { ui, props, snap } = c
  const b = snap.status?.branch ?? {}
  const prog = Object.entries(snap.status?.inProgress ?? {}).filter(([, v]) => v === true).map(([k]) => k)
  const behind = b.behind ?? 0
  const ahead = b.ahead ?? 0
  const repoName = String(props.dir ?? '').split('/').filter(Boolean).at(-1) ?? 'Git'
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap" paddingX={1}>
        <Button key="side" plain dimColor onPress={() => { ui.sidebar = !ui.sidebar; c.redraw() }}>☰</Button>
        <Button key="fetch" plain hotkey="f" onPress={() => c.m('fetch', {}, 'git fetch --all --prune')}>⟳ Fetch</Button>
        <Button key="pull" plain hotkey="l" onPress={() => c.m('pull', {}, 'git pull')}>{behind > 0 ? `↓ Pull  ${behind}` : '↓ Pull'}</Button>
        <Button key="push" plain hotkey="p" onPress={() => A.push(c)}>{b.upstream ? (ahead > 0 ? `↑ Push  ${ahead}` : '↑ Push') : '↑ Publish'}</Button>
        <Button key="stash" plain onPress={() => { A.stashNew(c); c.redraw() }}>⧉ Stash</Button>
        <Box flexGrow={1} />
        <Box flexDirection="column" alignItems="center" paddingX={2} backgroundColor={SURFACE}>
          <Text weight="semibold">{`${repoName}${(snap.status?.files?.length ?? 0) > 0 ? '*' : ''}`}</Text>
          <Button key="branch" plain hotkey="3" onPress={() => nav(c, 'branches', 0, b.name ?? undefined)}><Text size="footnote" color="claude">{`⎇ ${b.name ?? `(${b.shortOid ?? 'no branch'})`}  ▾`}</Text></Button>
        </Box>
        <Box flexGrow={1} />
        <Button key="newbranch" plain dimColor onPress={() => { A.branchNew(c); c.redraw() }}>⑂ New Branch</Button>
        <Button key="undo" plain dimColor hotkey="u" onPress={() => { A.undo(c); c.redraw() }}>↶ Undo</Button>
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

// ---- sidebar

const isOpen = (ui: Any, id: string, def: boolean) => (ui.open[id] === undefined ? def : ui.open[id] === true)

function SideItem(c: Any, o: { id: string; label: string; active?: boolean; indent?: number; glyph?: string; right?: string; weight?: string; hotkey?: string; onPress: () => void }) {
  const { Box, Text, Button } = c.E
  return (
    <Box key={`si-${o.id}`} flexDirection="row" alignItems="center" gap={1} paddingLeft={1 + (o.indent ?? 0) * 2} paddingRight={1} backgroundColor={o.active ? SEL_BG : undefined}>
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <Button key={`sib-${o.id}`} plain hotkey={o.hotkey} onPress={o.onPress}><Text wrap="truncate-end" color={o.active ? SEL_FG : undefined} weight={o.weight ?? 'medium'}>{`${o.glyph ? o.glyph + ' ' : ''}${o.label}`}</Text></Button>
      </Box>
      {o.right ? <Text size="footnote" color={o.active ? SEL_FG : 'subtle'}>{o.right}</Text> : null}
    </Box>
  )
}

function SideSection(c: Any, id: string, title: string, count: number | null, def: boolean, body: () => Any[]) {
  const { Box, Text, Button } = c.E
  const open = isOpen(c.ui, id, def)
  return (
    <Box key={`ss-${id}`} flexDirection="column">
      <Box flexDirection="row" alignItems="center" gap={1} paddingX={1} paddingY={1}>
        <Button key={`ssb-${id}`} plain onPress={() => { c.ui.open[id] = !open; c.redraw() }}><Text weight="semibold">{`${open ? '▾' : '▸'} ${title}`}</Text></Button>
        {count !== null ? <Text size="footnote" color="subtle">{String(count)}</Text> : null}
      </Box>
      {open ? <Box flexDirection="column">{body()}</Box> : null}
    </Box>
  )
}

// Names with `/` nest into folders, like Fork.
function nameTree(items: { name: string; data: Any }[]) {
  const root: Any = { dirs: new Map(), leaves: [] }
  for (const it of items) {
    const parts = it.name.split('/')
    let node = root
    for (const seg of parts.slice(0, -1)) {
      if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), leaves: [] })
      node = node.dirs.get(seg)
    }
    node.leaves.push({ label: parts[parts.length - 1], data: it.data, name: it.name })
  }
  return root
}

function renderTree(c: Any, node: Any, depth: number, path: string, leaf: (l: Any, depth: number) => Any, hasActive: (name: string) => boolean): Any[] {
  const out: Any[] = []
  for (const [seg, child] of [...node.dirs.entries()].sort((a: Any, b: Any) => a[0].localeCompare(b[0]))) {
    const id = `fd:${path}${seg}`
    const names: string[] = []
    const collect = (n: Any) => { n.leaves.forEach((l: Any) => names.push(l.name)); n.dirs.forEach((d: Any) => collect(d)) }
    collect(child)
    const open = isOpen(c.ui, id, names.some(hasActive))
    out.push(SideItem(c, { id, label: seg, glyph: open ? '▾ ▭' : '▸ ▭', indent: depth, onPress: () => { c.ui.open[id] = !open; c.redraw() } }))
    if (open) out.push(...renderTree(c, child, depth + 1, `${path}${seg}/`, leaf, hasActive))
  }
  for (const l of node.leaves) out.push(leaf(l, depth))
  return out
}

function Sidebar(c: Any) {
  const { Box, Text } = c.E
  const { ui, snap, props } = c
  const nFiles = snap.status?.files?.length ?? 0
  const repoName = String(props.dir ?? '').split('/').filter(Boolean).at(-1) ?? 'Git'
  const sel = ui.sel
  const activeKey = (tab: string, sub: number) => (ui.tab === tab && ui.sub === sub && sel ? sel.key : '')
  const local: Any[] = snap.branches?.local ?? []
  const remote: Any[] = snap.branches?.remote ?? []
  const remotes: string[] = [...new Set(remote.map((b: Any) => String(b.remote ?? '')).filter(Boolean))]
  const branchLeaf = (kind: number) => (l: Any, depth: number) => {
    const b = l.data
    return SideItem(c, {
      id: `${kind}:${l.name}`, label: l.label, indent: depth + 1, active: activeKey('branches', kind) === l.name,
      glyph: kind === 0 ? (b.current ? '✓' : '⑂') : '⑂', weight: kind === 0 && b.current ? 'bold' : 'medium',
      right: kind === 0 && b.current ? `${snap.status?.branch?.behind ? '↓' + snap.status.branch.behind : ''}${snap.status?.branch?.ahead ? ' ↑' + snap.status.branch.ahead : ''}`.trim() : '',
      onPress: () => nav(c, 'branches', kind, l.name),
    })
  }
  const sorted = [...local].sort((a: Any, b: Any) => (a.current === b.current ? a.name.localeCompare(b.name) : a.current ? -1 : 1))
  return (
    <Box flexDirection="column" gap={1}>
      <Box paddingX={1}><Text weight="semibold" size="heading" wrap="truncate-end">{repoName}</Text></Box>
      <Box flexDirection="column">
        {SideItem(c, { id: 'changes', label: nFiles > 0 ? `Local Changes (${nFiles})` : 'Local Changes', glyph: '▤', active: ui.tab === 'changes', hotkey: '1', onPress: () => nav(c, 'changes') })}
        {SideItem(c, { id: 'history', label: 'All Commits', glyph: '☰', active: ui.tab === 'history', hotkey: '2', onPress: () => nav(c, 'history') })}
      </Box>
      <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" />
      {(snap.worktrees ?? []).length > 1 ? SideSection(c, 'sec-worktrees', 'Worktrees', null, true, () => (snap.worktrees ?? []).map((w: Any) => SideItem(c, { id: `3:${w.path}`, label: String(w.path).split('/').filter(Boolean).at(-1) ?? w.path, glyph: '▭', indent: 1, weight: w.isCurrent ? 'bold' : 'medium', active: activeKey('branches', 3) === w.path, onPress: () => { if (dbl(c, `wt:${w.path}`)) openRepo(c, w.path); else nav(c, 'branches', 3, w.path) } }))) : null}
      {SideSection(c, 'sec-branches', 'Branches', local.length, true, () => renderTree(c, nameTree(sorted.map((b: Any) => ({ name: b.name, data: b }))), 0, 'b/', branchLeaf(0), (n) => activeKey('branches', 0) === n))}
      {SideSection(c, 'sec-remotes', 'Remotes', remotes.length, true, () => remotes.flatMap((r: string) => {
        const id = `rm:${r}`
        const open = isOpen(ui, id, false)
        const items = remote.filter((b: Any) => b.remote === r).map((b: Any) => ({ name: b.branch, data: { ...b, name: b.name } }))
        const leaf = (l: Any, depth: number) => SideItem(c, { id: `1:${r}/${l.name}`, label: l.label, indent: depth + 1, glyph: '⑂', active: activeKey('branches', 1) === `${r}/${l.name}`, onPress: () => nav(c, 'branches', 1, `${r}/${l.name}`) })
        return [
          SideItem(c, { id, label: r, glyph: open ? '▾ ◉' : '▸ ◉', indent: 0, weight: 'semibold', onPress: () => { ui.open[id] = !open; c.redraw() } }),
          ...(open ? renderTree(c, nameTree(items), 1, `${r}/`, leaf, (n) => activeKey('branches', 1) === `${r}/${n}`) : []),
        ]
      }))}
      {SideSection(c, 'sec-tags', 'Tags', (snap.tags ?? []).length, false, () => (snap.tags ?? []).map((t: Any) => SideItem(c, { id: `2:${t.name}`, label: t.name, glyph: '⌂', indent: 1, active: activeKey('branches', 2) === t.name, onPress: () => nav(c, 'branches', 2, t.name) })))}
      {SideSection(c, 'sec-stashes', 'Stashes', (snap.stashes ?? []).length, true, () => (snap.stashes ?? []).map((st: Any) => SideItem(c, { id: `st:${st.ref}`, label: st.message || st.ref, glyph: '⧉', indent: 1, active: ui.tab === 'stash' && sel?.key === st.ref, hotkey: undefined, onPress: () => nav(c, 'stash', 0, st.ref) })))}
      {SideSection(c, 'sec-reflog', 'Reflog', (snap.reflog ?? []).length, false, () => (snap.reflog ?? []).slice(0, 12).map((r: Any) => SideItem(c, { id: `4:${r.selector}`, label: `${r.selector} ${r.subject}`, glyph: '↺', indent: 1, active: activeKey('branches', 4) === r.selector, onPress: () => nav(c, 'branches', 4, r.selector) })))}
    </Box>
  )
}



function initSelection(c: Any, pick?: string) {
  const { ui, snap } = c
  const list = ui.tab === 'changes' ? flatFiles(snap, ui) : listFor(ui, snap)
  ui.sel = (pick !== undefined ? list.find((x: Any) => x.key === pick) : undefined) ?? list[0] ?? null
  loadDetail(c, true)
}

// Sidebar navigation: pick a view (and optionally one item in it).
function nav(c: Any, tab: string, sub = 0, pick?: string) {
  const { ui } = c
  ui.tab = tab
  ui.sub = sub
  ui.sel = null
  ui.detail = null
  ui.detailKey = ''
  ui.lines = []
  initSelection(c, pick)
  c.redraw()
}

// Buttons have no double-click: two presses on the same id within 450 ms count as one.
function dbl(c: Any, id: string): boolean {
  const now = Date.now()
  const last = c.ui.lastPress
  const hit = last !== undefined && last !== null && last.id === id && now - last.t < 450
  c.ui.lastPress = hit ? null : { id, t: now }
  return hit
}

// Open another folder (a worktree) as its own repository tab; the current one stays as a tab.
function openRepo(c: Any, dir: string) {
  c.req('setDir', { dir }, 'quiet')
}

function goCommit(c: Any, hash: string) {
  const { ui, snap } = c
  const found = [...(snap.commits ?? []), ...(ui.more ?? [])].find((x: Any) => x.hash === hash)
  ui.tab = 'history'
  ui.sub = 0
  ui.sel = found ? { kind: 'commit', key: found.hash, c: found } : { kind: 'commit', key: hash, c: { shortHash: hash.slice(0, 7), hash, subject: hash.slice(0, 10), author: '', date: '', fullDate: '', decorations: '', parents: [] } }
  ui.detail = null
  ui.detailKey = ''
  loadDetail(c, true)
  c.redraw()
}

function Row(c: Any, item: Any, left: Any[], right: Any = null) {
  const { Box, Text, Button } = c.E
  const on = itemKey(c.ui.sel) === itemKey(item)
  return (
    <Box key={`row-${itemKey(item)}`} flexDirection="row" alignItems="center" gap={1} paddingX={1} backgroundColor={on ? 'promptBorder' : undefined}>
      <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
        <Button key={`sel-${itemKey(item)}`} plain onPress={() => { if (item.kind === 'worktree' && dbl(c, `wt:${item.key}`)) openRepo(c, item.w.path); else selectItem(c, item) }}><Text wrap="truncate-end">{left}</Text></Button>
      </Box>
      {right}
    </Box>
  )
}

function fileItem(f: Any, group: string) {
  const untracked = f.kind === 'untracked'
  const conflict = f.kind === 'unmerged'
  const staged = !untracked && !conflict && f.x !== '.'
  const unstaged = untracked || conflict || f.y !== '.'
  return { kind: 'file', group, path: f.path, f, staged, unstaged }
}

// Fork's Local Changes: an Unstaged and a Staged list, each a folder tree with a status badge per file.
function FileSection(c: Any, group: 'unstaged' | 'staged', files: Any[]) {
  const { Box, Text, Button } = c.E
  const { ui } = c
  const staged = group === 'staged'
  const sfx = staged ? 's-' : ''
  const items = files.map((f: Any) => fileItem(f, staged ? 'staged' : f.kind === 'untracked' ? 'untracked' : f.kind === 'unmerged' ? 'conflict' : 'unstaged')).sort((a: Any, b: Any) => a.path.localeCompare(b.path))
  const paths = items.map((i: Any) => i.path)
  const seen = new Set<string>()
  const rows: Any[] = []
  for (const it of items) {
    const parts = it.path.split('/')
    parts.slice(0, -1).forEach((seg: string, depth: number) => {
      const id = parts.slice(0, depth + 1).join('/')
      if (seen.has(id)) return
      seen.add(id)
      rows.push(<Box key={`dir-${group}-${id}`} flexDirection="row" gap={1} paddingLeft={5 + depth * 2}><Text color="subtle">▾ ▭</Text><Text weight="medium">{seg}</Text></Box>)
    })
    const depth = parts.length - 1
    const l = staged ? it.f.x : it.group === 'untracked' ? '?' : it.group === 'conflict' ? 'U' : it.f.y
    const on = ui.sel?.kind === 'file' && ui.sel.path === it.path && ui.sel.group === it.group
    rows.push(
      <Box key={`row-${group}-${it.path}`} flexDirection="row" alignItems="center" gap={1} paddingX={1} backgroundColor={on ? SEL_BG : undefined}>
        {StatusBadge(c, `sb-${group}-${it.path}`, l)}
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" paddingLeft={depth * 2}>
          <Button key={`sel-${sfx}${it.path}`} plain onPress={() => selectItem(c, it)}><Text wrap="truncate-end" color={on ? SEL_FG : undefined} weight={on ? 'semibold' : 'medium'}>{parts[parts.length - 1]}</Text></Button>
        </Box>
        <Button key={`chk-${sfx}${it.path}`} plain dimColor onPress={() => (staged ? A.unstage(c, [it.path]) : A.stage(c, [it.path]))}><Text color={on ? SEL_FG : 'subtle'} weight="bold">{staged ? '−' : '+'}</Text></Button>
      </Box>,
    )
  }
  const n = items.length
  return (
    <Box key={`sec-${group}`} flexDirection="column" borderStyle="round" borderColor="promptBorder" backgroundColor={SURFACE} overflow="hidden">
      <Box flexDirection="row" alignItems="center" gap={2} paddingX={1} paddingY={1}>
        <Text weight="semibold">{staged ? 'Staged' : 'Unstaged'}</Text>
        {n > 0 ? <Text color="subtle" size="footnote">{String(n)}</Text> : null}
        <Box flexGrow={1} />
        {!staged && n > 0 ? <Button key="discard-all" plain dimColor onPress={() => { A.discardAll(c); c.redraw() }}>Discard all</Button> : null}
        {n > 0
          ? <Button key={staged ? 'unstage-all' : 'stage-all'} variant="secondary" onPress={() => (staged ? A.unstage(c, [], 'unstage all') : A.stage(c, paths, 'stage all'))}>{staged ? 'Unstage' : 'Stage'}</Button>
          : <Text color="subtle">{staged ? 'Unstage' : 'Stage'}</Text>}
      </Box>
      {n === 0 ? <Box paddingX={2} paddingBottom={1}><Text color="subtle" size="footnote">{staged ? 'Nothing staged.' : 'Working tree clean.'}</Text></Box> : <Box flexDirection="column" paddingBottom={1}>{rows}</Box>}
    </Box>
  )
}

function ChangesList(c: Any) {
  const { Box } = c.E
  const files: Any[] = c.snap.status?.files ?? []
  const real = (f: Any) => f.kind !== 'untracked' && f.kind !== 'unmerged'
  const unstaged = files.filter((f: Any) => !real(f) || f.y !== '.')
  const staged = files.filter((f: Any) => real(f) && f.x !== '.')
  return (
    <Box flexDirection="column" gap={1}>
      {FileSection(c, 'unstaged', unstaged)}
      {FileSection(c, 'staged', staged)}
    </Box>
  )
}

function CommitBox(c: Any) {
  const { Box, Text, Button, Input } = c.E
  const { ui, snap } = c
  const n = (snap.status?.files ?? []).filter((f: Any) => f.kind !== 'untracked' && f.kind !== 'unmerged' && f.x !== '.').length
  return (
    <Box flexDirection="column" gap={1} borderStyle="round" borderColor="promptBorder" backgroundColor={SURFACE} padding={1}>
      <Input key={`sum-${ui.commitN}`} placeholder="Commit subject" value={ui.sum} onInput={(v: string) => { ui.sum = v }} onSubmit={(v: string) => { ui.sum = v; A.commit(c) }} />
      <Input key={`desc-${ui.commitN}`} placeholder="Description" value={ui.desc} rows={3} onInput={(v: string) => { ui.desc = v }} onSubmit={(v: string) => { ui.desc = v }} />
      <Box flexDirection="row" alignItems="center" gap={2}>
        <Button key="amend" plain dimColor onPress={() => { ui.amend = !ui.amend; if (ui.amend) c.req('lastCommitMessage', {}, 'amendMsg'); c.redraw() }}>{ui.amend ? '☑ Amend' : '☐ Amend'}</Button>
        <Text color="subtle" size="caption">Commit hooks are skipped in this pane.</Text>
        <Box flexGrow={1} />
        <Button key="commit" variant="primary" hotkey="c" onPress={() => A.commit(c)}>{ui.amend ? 'Amend' : n > 0 ? `Commit ${n}` : 'Commit'}</Button>
      </Box>
    </Box>
  )
}

// ---------------------------------------------------------------- commit graph

// Lane layout for the commit table, newest commit first. Each row gets the line
// segments to draw (top half = coming from above, bottom half = going to parents).
type Seg = { x1: number; y1: number; x2: number; y2: number; color: number; curve: boolean }
export function layoutGraph(commits: Any[]) {
  const lanes: (string | null)[] = []
  const colors: number[] = []
  let nextColor = 0
  let maxLane = 0
  const rows: Any[] = []
  for (const cm of commits) {
    const before = lanes.slice()
    const beforeColors = colors.slice()
    let idx = lanes.indexOf(cm.hash)
    if (idx < 0) {
      idx = lanes.indexOf(null)
      if (idx < 0) { idx = lanes.length; lanes.push(null); colors.push(0) }
      colors[idx] = nextColor++ % LANE_COLORS.length
    }
    const nodeColor = colors[idx]!
    for (let i = 0; i < lanes.length; i += 1) if (lanes[i] === cm.hash) lanes[i] = null
    const outs: { lane: number; color: number }[] = []
    const parents: string[] = cm.parents ?? []
    parents.forEach((ph, k) => {
      const have = lanes.indexOf(ph)
      if (have >= 0) { outs.push({ lane: have, color: colors[have]! }); return }
      if (k === 0) { lanes[idx] = ph; outs.push({ lane: idx, color: nodeColor }); return }
      let slot = lanes.indexOf(null)
      if (slot < 0) { slot = lanes.length; lanes.push(null); colors.push(0) }
      colors[slot] = nextColor++ % LANE_COLORS.length
      lanes[slot] = ph
      outs.push({ lane: slot, color: colors[slot]! })
    })
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) { lanes.pop(); colors.pop() }
    const segs: Seg[] = []
    before.forEach((h, i) => {
      if (h === null || h === undefined) return
      if (h === cm.hash) segs.push({ x1: i, y1: 0, x2: idx, y2: 0.5, color: beforeColors[i]!, curve: i !== idx })
      else segs.push({ x1: i, y1: 0, x2: i, y2: 1, color: beforeColors[i]!, curve: false })
    })
    for (const o of outs) segs.push({ x1: idx, y1: 0.5, x2: o.lane, y2: 1, color: o.color, curve: o.lane !== idx })
    maxLane = Math.max(maxLane, idx, ...segs.map((x) => Math.max(x.x1, x.x2)))
    rows.push({ idx, color: nodeColor, merge: parents.length > 1, segs })
  }
  return { rows, width: (Math.min(maxLane, MAX_LANES - 1) + 1) * LANE_W + 8 }
}

function graphSvg(g: Any, width: number, selected: boolean) {
  const X = (lane: number) => 8 + Math.min(lane, MAX_LANES - 1) * LANE_W
  const H = ROW_H
  const col = (i: number) => LANE_COLORS[i % LANE_COLORS.length]
  const parts: string[] = []
  for (const sg of g.segs as Seg[]) {
    const x1 = X(sg.x1); const y1 = sg.y1 * H; const x2 = X(sg.x2); const y2 = sg.y2 * H
    const d = sg.curve ? `M${x1} ${y1} C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}` : `M${x1} ${y1} L${x2} ${y2}`
    parts.push(`<path d='${d}' stroke='${col(sg.color)}' stroke-width='1.6' fill='none' stroke-linecap='round'/>`)
  }
  const nx = X(g.idx)
  const nc = col(g.color)
  parts.push(g.merge
    ? `<circle cx='${nx}' cy='${H / 2}' r='5.5' fill='${selected ? '#0a64d8' : '#2b2b2e'}' stroke='${nc}' stroke-width='1.6'/><path d='M${nx - 3} ${H / 2}H${nx + 3}M${nx} ${H / 2 - 3}V${H / 2 + 3}' stroke='${nc}' stroke-width='1.4'/>`
    : `<circle cx='${nx}' cy='${H / 2}' r='4.2' fill='${nc}'/>`)
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${width}' height='${H}' viewBox='0 0 ${width} ${H}'>${parts.join('')}</svg>`
}

function parseRefs(deco: string, remotes: string[]) {
  const out: { tone: string; text: string }[] = []
  for (const raw of String(deco ?? '').replace(/^\s*\(|\)\s*$/g, '').split(',').map((x) => x.trim()).filter(Boolean)) {
    if (raw.startsWith('HEAD -> ')) out.push({ tone: 'head', text: `✓ ${raw.slice(8)}` })
    else if (raw === 'HEAD') out.push({ tone: 'head', text: 'HEAD' })
    else if (raw.startsWith('tag: ')) out.push({ tone: 'tag', text: raw.slice(5) })
    else out.push({ tone: remotes.some((r) => raw.startsWith(`${r}/`)) ? 'remote' : 'local', text: raw })
  }
  return out
}

const hexA = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${a})`

// A ref badge tinted with its branch's lane colour (grey when there is no lane).
function Badge(c: Any, key: string, r: { tone: string; text: string }, lane?: number) {
  const { Text } = c.E
  if (r.tone === 'tag') return <Text key={key} backgroundColor={TAG_BG} color={TAG_FG} size="footnote" weight="semibold">{` ${r.text} `}</Text>
  if (lane === undefined) return <Text key={key} backgroundColor={BADGE_BG} color={BADGE_FG} size="footnote" weight="semibold">{` ${r.text} `}</Text>
  const hex = LANE_COLORS[lane % LANE_COLORS.length]!
  const head = r.tone === 'head'
  return <Text key={key} backgroundColor={head ? hex : hexA(hex, 0.25)} color={head ? '#1c1c1e' : hex} size="footnote" weight="semibold">{` ${r.tone === 'remote' ? '◉ ' : ''}${r.text} `}</Text>
}

const remoteNames = (snap: Any): string[] => [...new Set((snap.branches?.remote ?? []).map((b: Any) => String(b.remote ?? '')).filter(Boolean))] as string[]

// One commit row: graph dot, subject with ref badges, author, SHA, date (Fork's table).
function CommitRow(c: Any, it: Any, wide: boolean, g: Any, gw: number) {
  const { Box, Text, Button, Svg } = c.E
  const on = itemKey(c.ui.sel) === itemKey(it)
  const fg = on ? SEL_FG : undefined
  const dim = on ? SEL_FG : 'subtle'
  const merge = (it.c.parents?.length ?? 0) > 1
  const refs = parseRefs(it.c.decorations, remoteNames(c.snap))
  const pick = () => selectItem(c, it)
  const cell = (k: string, node: Any, o: Any = {}) => (
    <Box key={`${k}-${it.key}`} width={o.width} flexGrow={o.grow ? 1 : 0} flexShrink={o.grow ? 1 : 0} minWidth={0} overflow="hidden">
      <Button key={`${k}b-${it.key}`} plain onPress={pick}>{node}</Button>
    </Box>
  )
  const subject = (
    <Text wrap="truncate-end" color={fg} weight={on ? 'semibold' : 'medium'}>
      {refs.length > 0 ? <Text>{refs.map((r, i) => <Text key={`rf${i}`}>{i > 0 ? ' ' : ''}{Badge(c, `bd${i}`, r, g?.color)}</Text>)}{'  '}</Text> : null}
      {it.c.subject}
    </Text>
  )
  return (
    <Box key={`row-${it.key}`} flexDirection="row" alignItems="center" gap={2} paddingX={1} height={undefined} backgroundColor={on ? SEL_BG : undefined}>
      {g ? <Box key={`g-${it.key}`} flexShrink={0}><Svg source={graphSvg(g, gw, on)} alt="commit graph" width={gw} height={ROW_H} /></Box> : cell('g', <Text color={on ? SEL_FG : YELLOW} weight="bold">{merge ? '⊕' : '●'}</Text>, { width: 3 })}
      {cell('s', subject, { grow: true })}
      {wide ? cell('a', <Text wrap="truncate-end" color={fg} size="footnote">{it.c.author}</Text>, { width: 16 }) : null}
      {wide ? cell('h', <Text mono color={dim} size="footnote">{it.c.shortHash}</Text>, { width: 9 }) : null}
      {cell('d', <Text wrap="truncate-end" color={dim} size="footnote">{wide ? (it.c.fullDate || it.c.date) : it.c.date}</Text>, { width: wide ? 23 : 15 })}
    </Box>
  )
}

const TITLES = ['Local branches', 'Remote branches', 'Tags', 'Worktrees', 'Reflog']

function ListTab(c: Any) {
  const { Box, Text, Button } = c.E
  const { ui, snap } = c
  const list = listFor(ui, snap)
  const rowsKey = `${ui.tab}:${ui.sub}`
  const cap: number = ui.rows[rowsKey] ?? 12
  const shown = list.slice(0, Math.max(cap, list.findIndex((x: Any) => itemKey(x) === itemKey(ui.sel)) + 1))
  const graph = ui.tab === 'history' ? layoutGraph(list.map((x: Any) => x.c)) : null
  const rows: Any[] = []
  if (list.length === 0) rows.push(<Box key="empty" padding={2}><Text color="subtle">{ui.tab === 'stash' ? 'No stashes.' : 'Nothing here.'}</Text></Box>)
  for (const [i, it] of shown.entries()) {
    if (it.kind === 'commit') rows.push(CommitRow(c, it, c.wide, graph?.rows[i], graph?.width ?? 0))
    else if (it.kind === 'stash') rows.push(Row(c, it, [<Text key="r" color="subtle" mono size="footnote">{it.s.ref}</Text>, <Text key="m" weight="medium"> {it.s.message}</Text>, <Text key="d" color="subtle" size="footnote">{`  ${it.s.date}`}</Text>]))
    else if (it.kind === 'local') rows.push(Row(c, it, [<Text key="c" color="success" weight="semibold">{it.b.current ? '✓ ' : '  '}</Text>, <Text key="n" weight={it.b.current ? 'semibold' : 'medium'}>{it.b.name}</Text>, it.b.upstream ? <Text key="u" color="subtle" size="footnote">{`  ↔ ${it.b.upstream}`}</Text> : null, <Text key="d" color="subtle" size="footnote">{`  ${it.b.date}`}</Text>]))
    else if (it.kind === 'remote') rows.push(Row(c, it, [<Text key="n" weight="medium">{it.b.name}</Text>, <Text key="d" color="subtle" size="footnote">{`  ${it.b.date}`}</Text>]))
    else if (it.kind === 'tag') rows.push(Row(c, it, [<Text key="n" weight="medium">{it.t.name}</Text>, <Text key="d" color="subtle" size="footnote">{`  ${it.t.date}`}</Text>]))
    else if (it.kind === 'worktree') {
      const flags = [it.w.main ? 'main' : '', it.w.isCurrent ? 'current' : '', it.w.locked ? 'locked' : '', it.w.prunable ? 'stale' : ''].filter(Boolean).join(' · ')
      rows.push(Row(c, it, [<Text key="b" weight="semibold">{it.w.branch ?? '(detached)'}</Text>, <Text key="p" color="subtle" size="footnote">{`  ${it.w.path}`}</Text>, flags ? <Text key="f" color="warning" size="footnote">{`  ${flags}`}</Text> : null]))
    } else rows.push(Row(c, it, [<Text key="s" color="subtle" mono size="footnote">{it.r.selector}</Text>, <Text key="m"> {it.r.subject}</Text>]))
  }
  const more = list.length - shown.length
  const canLoad = ui.tab === 'history' && (snap.hasMore && ui.more === null || ui.hasMore)
  return (
    <Box flexDirection="column" gap={1}>
      {ui.tab === 'branches' ? (
        <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap" paddingX={1}>
          <Text weight="semibold">{TITLES[ui.sub] ?? ''}</Text>
          <Box flexGrow={1} />
          {ui.sub === 0 ? <Button key="new-branch" plain dimColor onPress={() => { A.branchNew(c); c.redraw() }}>New branch…</Button> : null}
          {ui.sub === 3 ? <Button key="new-wt" plain dimColor onPress={() => { A.worktreeNew(c); c.redraw() }}>New worktree…</Button> : null}
          {ui.sub === 3 ? <Button key="prune" plain dimColor onPress={() => c.req('pruneWorktrees', { dryRun: true }, 'pruneDry')}>Prune</Button> : null}
        </Box>
      ) : null}
      <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" overflow="hidden">{rows}</Box>
      <Box flexDirection="row" gap={1} paddingX={1}>
        {more > 0 ? <Button key="rows-more" variant="secondary" onPress={() => { ui.rows[rowsKey] = cap + 20; c.redraw() }}>{`Show ${Math.min(20, more)} more`}</Button> : null}
        {more <= 0 && canLoad ? <Button key="load-more" variant="secondary" onPress={() => c.req('log', { limit: 50, skip: (snap.commits?.length ?? 0) + (ui.more?.length ?? 0) }, 'more')}>Load more</Button> : null}
        {ui.tab === 'stash' ? <Button key="stash-new" variant="secondary" onPress={() => { A.stashNew(c); c.redraw() }}>Stash changes…</Button> : null}
      </Box>
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
  const picks = new Set<number>(c.ui.lines)
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
    const picked = picks.has(idx)
    const body = l.length > 300 ? `${l.slice(1, 300)}…` : l.slice(1)
    const text = `${pad(o)} ${pad(n)}  ${add ? '+' : del ? '−' : ' '} ${body}`
    const node = <Text mono size="footnote" color="text" backgroundColor={picked ? 'rgba(56,139,253,0.35)' : add ? ADD_BG : del ? DEL_BG : undefined} wrap="truncate-end">{text}</Text>
    if (!((add || del) && opts.selectable)) {
      out.push(<Box key={`${opts.keyp}-dl-${idx}`} flexDirection="row" paddingLeft={4} overflow="hidden">{node}</Box>)
      return
    }
    out.push(
      <Box key={`${opts.keyp}-dl-${idx}`} flexDirection="row" alignItems="center" gap={1} overflow="hidden">
        <Box width={3} flexShrink={0}><Button key={`${opts.keyp}-pick-${idx}`} plain onPress={() => { const set = new Set<number>(c.ui.lines); if (set.has(idx)) set.delete(idx); else set.add(idx); c.ui.lines = [...set].sort((a, b) => a - b); c.redraw() }}><Text color={picked ? 'claude' : 'subtle'} mono>{picked ? '☑' : '☐'}</Text></Button></Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">{node}</Box>
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
  const max = c.ui.showAll[`diff:${it.path}`] ?? 150
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
      {raw.length > max ? <Button key="diff-more" variant="secondary" onPress={() => { c.ui.showAll[`diff:${it.path}`] = max + 300; c.redraw() }}>{`Show ${Math.min(300, raw.length - max)} more lines`}</Button> : null}
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

function filesOf(patch: string) {
  return String(patch ?? '').split(/^(?=diff --git )/m).filter((x) => x.startsWith('diff --git ')).map((chunk, i) => {
    const m = /^diff --git a\/(.+) b\/(.+)$/m.exec(chunk)
    const status = /^new file mode/m.test(chunk) ? 'A' : /^deleted file mode/m.test(chunk) ? 'D' : /^rename from/m.test(chunk) ? 'R' : 'M'
    return { path: m ? m[2]! : `file ${i + 1}`, status, chunk }
  })
}

function StatusBadge(c: Any, key: string, status: string) {
  const { Box, Svg } = c.E
  const bg = BADGE_STATUS[status] ?? BADGE_STATUS.M
  const ink = '#1c1c1e'
  let glyph = `<text x='8' y='11.5' text-anchor='middle' font-size='10' font-weight='700' fill='${ink}'>${status === 'R' || status === 'C' ? '→' : status === 'U' ? '!' : status}</text>`
  if (status === 'M' || status === 'T') glyph = `<circle cx='4.5' cy='8' r='1.3' fill='${ink}'/><circle cx='8' cy='8' r='1.3' fill='${ink}'/><circle cx='11.5' cy='8' r='1.3' fill='${ink}'/>`
  else if (status === 'A' || status === '?') glyph = `<path d='M8 4.5V11.5M4.5 8H11.5' stroke='${ink}' stroke-width='1.8' stroke-linecap='round'/>`
  else if (status === 'D') glyph = `<path d='M4.5 8H11.5' stroke='${ink}' stroke-width='1.8' stroke-linecap='round'/>`
  const source = `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'><rect x='0.5' y='0.5' width='15' height='15' rx='3' fill='${bg}'/>${glyph}</svg>`
  return <Box key={key} width={3} flexShrink={0} alignItems="center"><Svg source={source} alt={`status ${status}`} width={16} height={16} /></Box>
}

function Avatar(c: Any, name: string) {
  const { Box, Text } = c.E
  const initials = String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?'
  let hash = 0
  for (const ch of String(name)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0
  return (
    <Box key={`av-${name}`} width={6} height={3} flexShrink={0} alignItems="center" justifyContent="center" backgroundColor={AVATAR[hash % AVATAR.length]}>
      <Text color="#ffffff" weight="bold">{initials}</Text>
    </Box>
  )
}

function Field(c: Any, label: string, body: Any) {
  const { Box, Text } = c.E
  return (
    <Box key={`fld-${label}`} flexDirection="row" alignItems="center" gap={2}>
      <Box width={9} flexShrink={0}><Text color="subtle" size="caption">{label}</Text></Box>
      <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap" flexShrink={1} minWidth={0}>{body}</Box>
    </Box>
  )
}

// Fork's commit detail: Commit / Changes / File Tree tabs.
function CommitDetail(c: Any, d: Any, it: Any) {
  const { Box, Text, Button } = c.E
  const { ui } = c
  const files = filesOf(d.patch)
  const body = String(d.body ?? '').split('\n').slice(1).join('\n').trim()
  const person = (label: string, name: string, email: string, date: string) => (
    <Box key={`p-${label}`} flexDirection="row" alignItems="center" gap={2} flexGrow={1} flexShrink={1} minWidth={0}>
      {Avatar(c, name)}
      <Box flexDirection="column" flexShrink={1} minWidth={0}>
        <Text color="subtle" size="caption">{label}</Text>
        <Text wrap="truncate-end"><Text weight="semibold">{name}</Text><Text color="subtle" size="footnote">{`  ${email}`}</Text></Text>
        <Text color="subtle" size="footnote" wrap="truncate-end">{date}</Text>
      </Box>
    </Box>
  )
  const tab = (id: string, label: string) => <Button key={`ct-${id}`} variant={ui.ctab === id ? 'primary' : 'secondary'} onPress={() => { ui.ctab = id; c.redraw() }}>{label}</Button>
  let content: Any = null
  if (ui.ctab === 'changes') {
    content = (
      <Box flexDirection="column" gap={2}>
        {files.slice(0, 40).map((f, i) => (
          <Box key={`f-${i}`} flexDirection="column" borderStyle="round" borderColor="promptBorder">
            {FileBar(c, f.path)}
            {PatchRows(c, f.chunk, { selectable: false, keyp: `s${i}`, max: 120 })}
          </Box>
        ))}
      </Box>
    )
  } else if (ui.ctab === 'tree') {
    const seen = new Set<string>()
    const rows: Any[] = []
    for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
      const parts = f.path.split('/')
      parts.slice(0, -1).forEach((seg, depth) => {
        const id = parts.slice(0, depth + 1).join('/')
        if (seen.has(id)) return
        seen.add(id)
        rows.push(<Box key={`td-${id}`} flexDirection="row" gap={1} paddingLeft={depth * 2}><Text color="subtle">▾ ▭</Text><Text weight="medium">{seg}</Text></Box>)
      })
      rows.push(<Box key={`tf-${f.path}`} flexDirection="row" alignItems="center" gap={1} paddingLeft={(parts.length - 1) * 2}>{StatusBadge(c, `tb-${f.path}`, f.status)}<Text wrap="truncate-end">{parts[parts.length - 1]}</Text></Box>)
    }
    content = <Box flexDirection="column" gap={1}>{rows}</Box>
  } else {
    const parents: string[] = d.parents ?? []
    content = (
      <Box flexDirection="column" gap={2}>
        <Box flexDirection="row" gap={3} flexWrap="wrap">
          {person('AUTHOR', d.author, d.email, d.authorDate || d.date)}
          {person('COMMITTER', d.committer || d.author, d.committerEmail || d.email, d.committerDate || d.authorDate || d.date)}
        </Box>
        {parseRefs(d.decorations, remoteNames(c.snap)).length > 0 ? Field(c, 'REFS', parseRefs(d.decorations, remoteNames(c.snap)).map((r, i) => Badge(c, `rb${i}`, r))) : null}
        {Field(c, 'SHA', [<Text key="sha" mono size="footnote">{d.hash}</Text>, <Button key="copy-sha" plain dimColor onPress={() => c.req('copy', { text: d.hash }, 'quiet')}>Copy</Button>])}
        {parents.length > 0 ? Field(c, 'PARENTS', parents.map((ph) => <Button key={`par-${ph}`} plain onPress={() => goCommit(c, ph)}><Text color="suggestion" underline mono size="footnote">{ph.slice(0, 7)}</Text></Button>)) : null}
        <Box flexDirection="column" gap={1} paddingTop={1}>
          <Text weight="semibold" size="heading" wrap="wrap">{d.subject}</Text>
          {body ? <Text mono size="footnote" wrap="wrap">{body}</Text> : null}
        </Box>
        <Box flexDirection="row" alignItems="center" gap={2}>
          <Text color="subtle" size="footnote">{`${files.length} changed file${files.length === 1 ? '' : 's'}`}</Text>
          <Box flexGrow={1} />
          {files.length > 0 ? <Button key="expand-all" plain dimColor onPress={() => { ui.ctab = 'changes'; c.redraw() }}>Expand All</Button> : null}
        </Box>
        <Box flexDirection="column" gap={1}>
          {files.slice(0, 60).map((f) => {
            const { name, dir } = splitPath(f.path)
            return (
              <Box key={`cf-${f.path}`} flexDirection="row" alignItems="center" gap={2}>
                {StatusBadge(c, `cb-${f.path}`, f.status)}
                <Button key={`cfb-${f.path}`} plain onPress={() => { ui.ctab = 'changes'; c.redraw() }}><Text wrap="truncate-start"><Text color="subtle">{dir}</Text><Text weight="medium">{name}</Text></Text></Button>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" gap={2}>
      <Box flexDirection="row" gap={1}>{tab('commit', 'Commit')}{tab('changes', 'Changes')}{tab('tree', 'File Tree')}</Box>
      {content}
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
    add('Open in new tab', () => openRepo(c, it.w.path), 'primary')
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
  else if ((it.kind === 'commit' || it.kind === 'stash' || it.kind === 'tag' || it.kind === 'reflog') && d?.subject !== undefined) return <Box flexDirection="column" gap={2}>{Actions(c, it, d)}{CommitDetail(c, d, it)}</Box>
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

  const cols = Number(props.cols ?? 120)
  c.wide = cols * (ui.sidebar ? 0.7 : 1) >= 82
  const side = ui.sidebar
  const main = ui.tab === 'changes' && c.wide ? (
    <Box flexDirection="row" gap={2} alignItems="flex-start" width="100%" overflow="hidden">
      <Box flexDirection="column" width="38%" minWidth="38%" flexGrow={0} flexShrink={0} gap={1} overflow="hidden">{ChangesList(c)}</Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} gap={2} overflow="hidden">{Detail(c)}{CommitBox(c)}</Box>
    </Box>
  ) : (
    <Box flexDirection="column" gap={2} width="100%" overflow="hidden">
      {ui.tab === 'changes' ? ChangesList(c) : ListTab(c)}
      <Box flexDirection="column" backgroundColor={SURFACE} padding={1} overflow="hidden">{Detail(c)}</Box>
      {ui.tab === 'changes' ? CommitBox(c) : null}
    </Box>
  )
  return (
    <Box flexDirection="column" gap={1} padding={1}>
      {RepoTabs(c)}
      {Toolbar(c)}
      {ui.notice ? (
        <Box flexDirection="row" alignItems="center" gap={2} borderStyle="round" borderColor="error" paddingX={1}>
          <Text color="error" wrap="wrap">{ui.notice}</Text>
          <Box flexGrow={1} />
          <Button key="dismiss" plain dimColor onPress={() => { ui.notice = ''; c.redraw() }}>Dismiss</Button>
        </Box>
      ) : null}
      {ui.dialog ? Dialog(c) : null}
      <Box flexDirection="row" gap={1} alignItems="flex-start" width="100%" overflow="hidden">
        {side ? <Box flexDirection="column" width="27%" minWidth="27%" flexGrow={0} flexShrink={0} overflow="hidden" backgroundColor={SURFACE}>{Sidebar(c)}</Box> : null}
        <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">{main}</Box>
      </Box>
      {Activity(c)}
    </Box>
  )
}
