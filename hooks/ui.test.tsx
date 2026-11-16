import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'git-for-claude',
  component: 'Pane',
  requestId: 'git',
  props: { title: 'Git', isFocused: true, bodyColumns: 120, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the pane mounts on every surface', async ($, on) => {
  on('store.get', () => ({ value: [] }))
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const client = await ui.find({ type: 'Text' })
    expect(client).toBeTruthy()
    await ui.unmount()
  }
})
