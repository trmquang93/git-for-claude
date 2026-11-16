export type Snapshot = {
  status: any
  branches?: any
  commits?: any[]
  hasMore?: boolean
  stashes?: any[]
  tags?: any[]
  remotes?: any[]
  worktrees?: any[]
  reflog?: any[]
  stat?: { add: number; del: number }
}

export type Reply = {
  id: number
  method: string
  tag: string
  label: string
  ok: boolean
  data?: any
  error?: string
}

export type View = {
  dir: string
  rev: number
  snap: Snapshot | null
  reply: Reply | null
  image: any | null
  error: string
  autoOpened: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'git-for-claude': { view: Shaped<View> }
  }
}
