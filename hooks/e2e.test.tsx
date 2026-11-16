import { expect, test } from 'claude-code/testing'

import { RECORDED } from './recorded'

const FIX = '/tmp/dsh-git-fixture'
const PANE = {
  plugin: 'git-for-claude', component: 'Pane', requestId: 'git',
  props: { title: 'Git', isFocused: true, bodyColumns: 140, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

let opened = 0
const missing: string[] = []
const calls: string[][] = []
const stdins: string[] = []
const stored: string[] = []
let BIG = ''
function answer(e: any) {
  const argv = e.argv
  const init = e.init ?? {}
  if (BIG !== '' && argv?.includes('diff') && argv.includes('multi.txt')) return { exitCode: 0, stdout: BIG, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  if (argv?.[0] === 'mktemp') return { exitCode: 0, stdout: '/tmp/mockdir\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  if (argv?.includes('checkout-index') || argv?.includes('read-tree') || argv?.[0] === 'rm') return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  if (argv?.[0] === 'git' && argv[1] === 'rev-parse') return { exitCode: 0, stdout: FIX + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  if (argv?.[0] === 'git' && argv[1] === 'diff' && argv[2] === '--numstat') return { exitCode: 0, stdout: '5\t2\tmulti.txt\n1\t1\tsrc/a.txt\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  if (argv?.[0] === 'pwd') return { exitCode: 0, stdout: FIX + '\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  calls.push(argv); stdins.push(init.stdin ?? '')
  const hit = RECORDED[JSON.stringify([argv, init.cwd ?? '', init.stdin ?? ''])]
  if (hit) return hit
  const joined = argv.join(' ')
  if (/ (add|restore|apply|commit|reset|checkout|stash|push|pull|fetch|branch|clean|rm) /.test(' ' + joined.replace(/^.* git /, '') + ' ')) return { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
  missing.push(JSON.stringify(argv).slice(-60))
  return { exitCode: 1, stdout: '', stderr: 'not recorded', isStdoutTruncated: false, isStderrTruncated: false }
}

async function setup($: any, on: any) {
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', (_: any, e: any) => ({ value: answer(e) }))
  on('fs.stat', () => ({ value: { kind: 'file', size: 70, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } }))
  on('store.get', () => ({ value: [] }))
  on('store.set', (_: any, e: any) => { stored.push(JSON.stringify(e)); return { value: undefined } })
  on('command.register', () => ({ value: { command: 'git' } }))
  on('ui.open', () => { opened += 1; return { value: { isPlaced: true } } })
  on('ui.status', () => ({ value: undefined }))
  await $.session.start({ cwd: FIX, surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'git', args: '' })
}

const gitArgs = () => calls.map(c => c.slice(c.indexOf('git') + 1).join(' '))
const settle = async (ui: any) => { for (let i = 0; i < 6; i++) await ui.advance(60) }
const texts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((t: any) => t.text).join('\n')
const press = async (ui: any, key: string) => { await ui.press({ key }); await settle(ui) }

test('Changes tab lists grouped files and the first diff', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await settle(ui)
  const out = await texts(ui)
  for (const word of ['Unstaged', 'b.txt', 'multi.txt', 'untracked.txt', 'main', 'Commit hooks are skipped']) expect(out).toContain(word)
  expect(missing.length).toBe(0)
  await ui.unmount()
})

test('selecting a file shows its diff; lines and files stage through git', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await settle(ui)
  await press(ui, 'sel-multi.txt')
  expect(await texts(ui)).toContain('LINE 2 changed')

  // click the "-line 2" row (raw patch index 6), then stage only that line
  calls.length = 0; stdins.length = 0
  await press(ui, 'd-pick-6')
  await press(ui, 'apply-lines')
  const apply = gitArgs().findIndex(a => a.startsWith('apply --cached'))
  expect(apply).toBeGreaterThan(-1)
  expect(stdins[apply]).toContain('-line 2')
  expect(stdins[apply]).not.toContain('LINE 5 changed')

  // stage the whole file from its row button
  calls.length = 0
  await press(ui, 'chk-multi.txt')
  expect(gitArgs().some(a => a.startsWith('add -A -- multi.txt'))).toBe(true)
  await ui.unmount()
})

test('commit box sends the message to git commit', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await settle(ui)
  await $.ui.input({ plugin: 'git-for-claude', key: 'sum-0', text: 'my message', kind: 'change' } as any)
  calls.length = 0; stdins.length = 0
  await press(ui, 'commit')
  const i = gitArgs().findIndex(a => a.includes('commit'))
  expect(i).toBeGreaterThan(-1)
  expect(gitArgs()[i] + ' ' + stdins[i]).toContain('my message')
  await ui.unmount()
})

test('an image file shows before and after previews', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await settle(ui)
  await press(ui, 'sel-logo.png')
  const all = await ui.findAll({ type: 'Svg' })
  const imgs = all.filter((x: any) => /image$/.test(x.props?.alt ?? ''))
  expect(imgs.length).toBe(2)
  await ui.unmount()
})

test('tabs and header buttons work', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await settle(ui)
  await press(ui, 'sib-history')
  expect(await texts(ui)).toContain('initial commit')
  await press(ui, 'sib-changes')
  await press(ui, 'sib-st:stash@{0}')
  expect(await texts(ui)).toContain('WIP on main')
  await press(ui, 'branch')
  expect(await texts(ui)).toContain('origin/main')
  calls.length = 0
  await press(ui, 'fetch')
  expect(gitArgs().some(a => a.startsWith('fetch'))).toBe(true)
  await ui.unmount()
})

test('a new session in a git repository does not open the pane by itself', async ($, on) => {
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  on('process.run', (_: any, e: any) => ({ value: answer(e) }))
  on('store.get', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'git' } }))
  on('ui.open', () => { opened += 1; return { value: { isPlaced: true } } })
  on('ui.status', () => ({ value: undefined }))
  opened = 0
  await $.session.start({ cwd: FIX, surface: 'desktop', isInteractive: true })
  await $.clock?.sleep?.(10)
  for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 10))
  expect(opened).toBe(0)
})

test('the Open Git button above the prompt opens the pane', async ($, on) => {
  await setup($, on)
  const bar = await $.ui.mount({ plugin: 'git-for-claude', component: 'AbovePrompt', requestId: 'band', props: { hasSurvey: false, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} }, surface: 'desktop' } as any)
  const shown = (await bar.findAll({ type: 'Text' })).map((x: any) => x.text).join('|')
  expect(shown).toContain('+6')
  expect(shown).toContain('−3')
  opened = 0
  await bar.press({ key: 'open-git' })
  for (let i = 0; i < 20 && opened === 0; i++) await new Promise(r => setTimeout(r, 10))
  expect(opened).toBe(1)
  await bar.unmount()
})

test('a session that never ran session.start still finds its repository from the band', async ($, on) => {
  on('process.run', (_: any, e: any) => ({ value: answer(e) }))
  on('store.get', () => ({ value: [] }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.render', ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
  const bar = await $.ui.mount({ plugin: 'git-for-claude', component: 'AbovePrompt', requestId: 'band2', props: { hasSurvey: false, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} }, surface: 'desktop' } as any)
  for (let i = 0; i < 40; i++) { await bar.advance(50); await new Promise(r => setTimeout(r, 10)) }
  const shown = (await bar.findAll({ type: 'Text' })).map((x: any) => x.text).join('|')
  expect(shown).toContain('+6')
  await bar.unmount()
})

test('Fork layout: sidebar, commit table with ref badges, and the Commit / Changes / File Tree detail', async ($, on) => {
  missing.length = 0
  await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await settle(ui)
  const side = await texts(ui)
  for (const word of ['Local Changes (5)', 'All Commits', 'Branches', 'Remotes', 'origin']) expect(side).toContain(word)
  for (const key of ['fetch', 'pull', 'push', 'stash', 'newbranch', 'sib-changes', 'sib-history']) expect(await ui.find({ type: 'Button', key })).toBeTruthy()
  expect(side.indexOf('Worktrees')).toBeGreaterThan(-1)
  expect(side.indexOf('Worktrees')).toBeLessThan(side.indexOf('Branches'))
  await press(ui, 'sib-history')
  let out = await texts(ui)
  for (const word of ['initial commit', '✓ main', 'origin/main', 'v1', 'Mar 29, 2021 at 13:21', 'AUTHOR', 'COMMITTER', 'SHA', 'REFS', 'Test']) expect(out).toContain(word)
  await press(ui, 'ct-tree')
  out = await texts(ui)
  expect(out).toContain('src')
  expect(out).toContain('a.txt')
  await press(ui, 'ct-changes')
  expect(await texts(ui)).toContain('src/a.txt')
  await press(ui, 'sib-changes')
  expect(await texts(ui)).toContain('Unstaged')
  expect(missing).toEqual([])
  await ui.unmount()
})

test('All Commits draws a branch graph: one SVG per row, lanes for a merged branch', async ($, on) => {
  await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await settle(ui)
  await press(ui, 'sib-history')
  const svgs = await ui.findAll({ type: 'Svg' })
  const graph = svgs.filter((x: any) => x.props?.alt === 'commit graph')
  expect(graph.length).toBeGreaterThan(0)
  expect(graph[0].props.source).toContain('<circle')
  await ui.unmount()
})

test('a large diff with long lines renders quickly', async ($, on) => {
  const lines: string[] = ['diff --git a/multi.txt b/multi.txt', 'index 111..222 100644', '--- a/multi.txt', '+++ b/multi.txt', '@@ -1,400 +1,800 @@']
  for (let i = 0; i < 800; i++) lines.push(`${i % 3 === 0 ? '-' : '+'}  const x${i} = '${'<svg xmlns=\'http://www.w3.org/2000/svg\'>'.repeat(5)}' + ${i}`)
  BIG = lines.join('\n') + '\n'
  await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await settle(ui)
  const t0 = Date.now()
  await press(ui, 'sel-multi.txt')
  const ms = Date.now() - t0
  const n = (await ui.findAll({ type: 'Text' })).length
  console.log(`BIGDIFF select+render ${ms}ms, ${n} texts`)
  BIG = ''
  await ui.unmount()
})

test('double press on a worktree opens it as a repository tab and keeps the current one', async ($, on) => {
  stored.length = 0
  await setup($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await settle(ui)
  const btn = (await ui.findAll({ type: 'Button' })).find((b: any) => String(b.props?.key ?? '').startsWith('sib-3:'))
  expect(btn).toBeTruthy()
  const key = btn.props.key
  await ui.press({ key })
  expect(stored.length).toBe(0)
  await ui.press({ key })
  await settle(ui)
  expect(stored.some(x => x.includes(FIX))).toBe(true)
  await ui.unmount()
})
