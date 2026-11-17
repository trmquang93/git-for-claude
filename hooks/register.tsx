import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Reply, Snapshot, View } from '../types'
import { createApi } from './engine'
import { GitView, initUi, onReply } from './view'

const PANE = 'git'
const STORE_RECENTS = 'git-for-claude/recentRepos'
const EDIT_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit'])
const QUIET = new Set(['diff', 'show', 'log', 'status', 'branches', 'lastCommitMessage', 'image', 'previewImage', 'clearImage', 'refresh', 'copy', 'sendToChat', 'setDir', 'closeRepo', 'stashList', 'tags', 'remotes', 'reflog', 'worktrees'])
const TEXT_CAP = 60000
const PROPS_CAP = 90000

const EMPTY: View = { dir: '', rev: 0, snap: null, reply: null, image: null, error: '', autoOpened: false }
// Change the tag when a field of View changes: it declines what an earlier
// version stored, which outlives a reload.
const view = atom({ plugin: 'git-for-claude', key: 'view' } as const, EMPTY, { shape: 'view-2' })

let refreshGeneration = 0
let UI: any = null
let pending = 0
let detecting = false
let polling = false

const io = ($: any) => ({
  run: (argv: string[], init?: any) => $.process.run(argv, init),
  fileSize: async (file: string) => {
    try {
      const s = await $.fs.stat(file)
      return s.kind === 'file' ? s.size : null
    } catch {
      return null
    }
  },
  readBase64: async (file: string) => (await $.fs.read(file, { as: 'bytes' })).base64,
  warn: (_: string) => {},
})

const api = ($: any) => createApi(io($))

function cap(text: unknown) {
  const s = typeof text === 'string' ? text : ''
  return s.length > TEXT_CAP ? { text: s.slice(0, TEXT_CAP), cut: s.length - TEXT_CAP } : { text: s, cut: 0 }
}

async function loadSnapshot($: any, dir: string): Promise<Snapshot> {
  const g = api($)
  const status = await g.status({ dir })
  if (status.isRepo === false) return { status }
  const numstat = await $.process.run(['git', 'diff', '--numstat', 'HEAD'], { cwd: dir }).catch(() => null)
  let add = 0
  let del = 0
  for (const l of String(numstat?.stdout ?? '').split('\n')) {
    const m = /^(\d+)\t(\d+)\t/.exec(l)
    if (m) { add += Number(m[1]); del += Number(m[2]) }
  }
  const [branches, log, stashes, tags, remotes, worktrees, reflog] = await Promise.all([
    g.branches({ dir }).catch(() => ({ local: [], remote: [] })),
    g.log({ dir, limit: 50 }).catch(() => ({ commits: [], hasMore: false })),
    g.stashList({ dir }).catch(() => ({ stashes: [] })),
    g.tags({ dir }).catch(() => ({ tags: [] })),
    g.remotes({ dir }).catch(() => ({ remotes: [] })),
    g.worktrees({ dir }).catch(() => ({ worktrees: [] })),
    g.reflog({ dir, limit: 30 }).catch(() => ({ entries: [] })),
  ])
  const snap: Snapshot = {
    status,
    branches,
    commits: log.commits,
    hasMore: log.hasMore,
    stashes: stashes.stashes,
    tags: tags.tags,
    remotes: remotes.remotes,
    worktrees: worktrees.worktrees,
    reflog: reflog.entries,
    stat: { add, del },
  }
  // A Client's props are capped at 100000 characters: trim the longest lists.
  const fit = () => JSON.stringify(snap).length
  while (fit() > PROPS_CAP) {
    if ((snap.status.files?.length ?? 0) > 200) snap.status = { ...snap.status, files: snap.status.files.slice(0, Math.floor(snap.status.files.length * 0.7)), truncated: true }
    else if ((snap.commits?.length ?? 0) > 10) snap.commits = snap.commits!.slice(0, Math.floor(snap.commits!.length * 0.7))
    else if ((snap.tags?.length ?? 0) > 10) snap.tags = snap.tags!.slice(0, 10)
    else break
  }
  return snap
}

async function refresh($: any, dir?: string) {
  const v = await read($, view)
  const d = dir ?? v.dir
  if (d === '') return
  let snap: Snapshot
  let error = ''
  try {
    snap = await loadSnapshot($, d)
  } catch (e) {
    snap = { status: { isRepo: false, dir: d, error: String(e) } }
    error = String(e)
  }
  const before = await read($, view)
  // Relative dates ("3 seconds ago") change on every poll: leave them out, or the pane
  // would redraw and reload the open diff every few seconds.
  const stable = (x: unknown) => JSON.stringify(x, (k, v) => (k === 'date' ? undefined : v))
  const same = before.dir === d && before.error === error && stable(before.snap) === stable(snap)
  if (!same) await update($, view, (cur: View) => ({ ...cur, dir: d, snap, rev: cur.rev + 1, error }))
  const b = snap.status?.branch
  if (snap.status?.isRepo === false || b === undefined) $.ui.status(undefined)
  else $.ui.status(`⎇ ${b.name ?? b.shortOid ?? 'detached'}${b.ahead ? ` ↑${b.ahead}` : ''}${b.behind ? ` ↓${b.behind}` : ''}`)
}

async function rememberRepo($: any, root: string) {
  const list = ((await $.store.get(STORE_RECENTS)) as string[] | undefined) ?? []
  await $.store.set(STORE_RECENTS, [root, ...list.filter((p) => p !== root)].slice(0, 12))
}

async function sessionDir($: any): Promise<string> {
  const r = await $.process.run(['pwd'])
  return r.stdout.trim()
}

async function ensureDir($: any) {
  const v = await read($, view)
  if (v.dir !== '') return v.dir
  const dir = await sessionDir($)
  await update($, view, (cur: View) => ({ ...cur, dir }))
  return dir
}

// Find the session's repository on demand (a session that was already running when the
// mod loaded never got session.start), then keep the snapshot fresh.
async function detect($: any) {
  if (detecting) return
  detecting = true
  try {
    const v = await read($, view)
    if (v.dir !== '') { startPolling($); return }
    const cwd = await sessionDir($)
    const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
    if (r.exitCode !== 0) return
    const root = r.stdout.trim()
    await update($, view, (cur: View) => ({ ...cur, dir: root }))
    await refresh($, root)
    startPolling($)
  } finally {
    detecting = false
  }
}

// Changes made outside Claude (editor, terminal) show up within a few seconds.
function startPolling($: any) {
  if (polling) return
  polling = true
  void (async () => {
    for (;;) {
      await $.clock.sleep(4000)
      const v = await read($, view)
      if (v.dir !== '') await refresh($, v.dir).catch(() => {})
    }
  })().catch(() => { polling = false })
}

async function handle($: any, e: any, msg: any) {
  const { id, method, tag = '', label = '' } = msg
  const request = msg.request ?? {}
  const v = await read($, view)
  const dir: string = request.dir ?? v.dir
  const g = api($)
  let data: any
  let ok = true
  let error = ''
  let snapDir = dir
  let reload = false
  try {
    switch (method) {
      case 'refresh':
        reload = true
        break
      case 'setDir': {
        snapDir = String(request.dir ?? '')
        if (v.dir !== '' && v.dir !== snapDir) await rememberRepo($, v.dir)
        const st = await g.status({ dir: snapDir })
        if (st.isRepo !== false) await rememberRepo($, st.root)
        await update($, view, (cur: View) => ({ ...cur, dir: st.root ?? snapDir, image: null }))
        snapDir = st.root ?? snapDir
        reload = true
        break
      }
      case 'closeRepo': {
        const gone = String(request.dir ?? '')
        const list = (((await $.store.get(STORE_RECENTS)) as string[] | undefined) ?? []).filter((p) => p !== gone)
        await $.store.set(STORE_RECENTS, list)
        if (gone === v.dir && list[0] !== undefined) {
          const st = await g.status({ dir: list[0] })
          snapDir = st.root ?? list[0]
          await rememberRepo($, snapDir)
          await update($, view, (cur: View) => ({ ...cur, dir: snapDir, image: null }))
          reload = true
        }
        break
      }
      case 'copy':
        await $.ui.copy({ text: String(request.text ?? ''), surface: e.surface })
        break
      case 'sendToChat':
        await $.prompt.fill({ text: String(request.text ?? ''), mode: 'insert' })
        break
      case 'clearImage':
        if (v.image !== null) await update($, view, (cur: View) => ({ ...cur, image: null }))
        break
      case 'previewImage': {
        const img = await g.image({ dir, ...request })
        await update($, view, (cur: View) => ({ ...cur, image: img }))
        data = {}
        break
      }
      case 'diff':
      case 'show': {
        data = await (g as any)[method]({ dir, ...request })
        const c = cap(data.patch)
        data = { ...data, patch: c.text, truncated: c.cut }
        break
      }
      default: {
        if (typeof (g as any)[method] !== 'function') throw new Error(`unknown request: ${method}`)
        data = await (g as any)[method]({ dir, ...request })
        if (!QUIET.has(method)) reload = true
        if (data && typeof data === 'object') {
          for (const k of ['stdout', 'stderr', 'output']) if (typeof data[k] === 'string') data[k] = data[k].slice(0, 8000)
        }
      }
    }
  } catch (err) {
    ok = false
    error = err instanceof Error ? err.message : String(err)
    reload = !QUIET.has(method)
  }
  const reply: Reply = { id, method, tag, label, ok, data, error }
  if (reload) await refresh($, snapDir)
  await update($, view, (cur: View) => ({ ...cur, reply }))
  return reply
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'git', description: 'Open the Git pane (files, staging, commits, branches, worktrees)' })
    const result = await next(e)
    // Detect the repository so the prompt band shows branch and changes; the pane opens only on /git or the Git button.
    void (async () => {
      const v = await read($, view)
      if (v.autoOpened) return
      const cwd = (e as any).cwd || (await sessionDir($))
      const r = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd })
      if (r.exitCode !== 0) return
      const root = r.stdout.trim()
      await update($, view, (cur: View) => ({ ...cur, dir: root, autoOpened: true }))
      await refresh($, root)
      startPolling($)
    })().catch(() => {})
    return result
  })

  on('command.run', { command: 'git' }, async $ => {
    // Follow the session's current folder each time /git runs.
    const dir = await sessionDir($)
    await update($, view, (cur: View) => ({ ...cur, dir, image: null }))
    await $.ui.open({ id: PANE, title: 'Git' })
    await refresh($, dir)
    return { text: 'Git pane opened.' }
  })

  on('ui.message', async ($, e, next) => {
    const data = e.data as any
    if (e.element === 'git' && data && typeof data.method === 'string') {
      await handle($, e, data)
      return {}
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (EDIT_TOOLS.has(e.tool)) {
      // Refresh in the background: never hold the tool's result back.
      void (async () => {
        const v = await read($, view)
        if (v.dir === '') return
        const mine = ++refreshGeneration
        await $.clock.sleep(300)
        if (mine === refreshGeneration) await refresh($, v.dir)
      })().catch(() => {})
    }
    return result
  })

  // A slim button above the prompt that opens (or re-opens) the Git pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const v = await read($, view)
    if (v.dir === '') { void detect($).catch(() => {}); return next(e) }
    startPolling($)
    if (v.snap?.status?.isRepo === false) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e) as any
    const b = v.snap?.status?.branch
    const n = v.snap?.status?.files?.length ?? 0
    const open = async () => {
      await $.ui.open({ id: PANE, title: 'Git' })
      await refresh($, v.dir)
    }
    const stat = v.snap?.stat
    return (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <Text dimColor size="footnote">{b ? `⎇ ${b.name ?? b.shortOid ?? 'detached'}${n ? '' : '  ·  clean'}` : ''}</Text>
        <Box flexGrow={1} />
        {stat && (stat.add > 0 || stat.del > 0) ? <Text color="success" weight="semibold">{`+${stat.add}`}</Text> : null}
        {stat && (stat.add > 0 || stat.del > 0) ? <Text color="error" weight="semibold">{`−${stat.del}`}</Text> : null}
        <Button key="open-git" variant="secondary" onPress={() => { void open() }}>{stat && (stat.add > 0 || stat.del > 0) ? '± Git' : 'Git'}</Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const E = $.ui.resolve(e) as any
    const v = await read($, view)
    const recents = ((await $.store.get(STORE_RECENTS)) as string[] | undefined) ?? []
    UI ??= initUi()
    const redraw = () => $.ui.invalidate('ui.render')
    const act = {
      redraw,
      req: (method: string, request: any = {}, tag = '', label = '') => {
        pending += 1
        redraw()
        void handle($, e, { id: Date.now(), method, request, tag, label })
          .then((reply: any) => onReply(UI, reply))
          .catch((err: unknown) => onReply(UI, { ok: false, method, tag, label, error: String(err) }))
          .finally(() => { pending -= 1; redraw() })
      },
    }
    return GitView(E, { cols: (e as any).props?.bodyColumns, dir: v.dir, rev: v.rev, snap: v.snap, image: v.image, error: v.error, recents, busy: pending > 0 }, UI, act)
  })
}

