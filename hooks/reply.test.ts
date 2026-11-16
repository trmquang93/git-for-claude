import { test, expect } from 'claude-code/testing'
import { onReply } from './view'

// A diff that fails (timeout, too large) must not leave the pane on "Loading…" forever.
test('a failed diff request shows an error instead of Loading', () => {
  const ui: any = { detailKey: 'file:a.ts|unstaged|3', detail: { kind: 'loading' }, notice: '', log: [] }
  onReply(ui, { ok: false, tag: 'detail:file:a.ts|unstaged|3', error: 'git diff failed (timeout)' })
  expect(ui.detail.error).toContain('timeout')
})

// The 4s poll bumps rev while a big diff loads; its reply must still land.
test('a diff reply still lands after the rev moved on', () => {
  const ui: any = { detailKey: 'file:a.ts|unstaged|4', detail: { kind: 'loading' }, notice: '', log: [] }
  onReply(ui, { ok: true, tag: 'detail:file:a.ts|unstaged|3', data: { patch: '@@ -1 +1 @@' } })
  expect(ui.detail.patch).toBe('@@ -1 +1 @@')
})

test('a reply for a different file is dropped', () => {
  const ui: any = { detailKey: 'file:b.ts|unstaged|4', detail: { kind: 'loading' }, notice: '', log: [] }
  onReply(ui, { ok: true, tag: 'detail:file:a.ts|unstaged|4', data: { patch: 'x' } })
  expect(ui.detail.patch).toBeUndefined()
})
