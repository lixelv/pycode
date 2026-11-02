import { runTool, type AgentContext, type ToolResult } from "./tools"

/*
 * A /mcp-driven tab: its id, which survives a reload and not a duplication, and
 * what it does with the messages of its control socket.
 */

const TAB_KEY = "polycode:mcp-tab"
const CHANNEL = "polycode:mcp-tabs"
/** How long a living tab has to say an id is taken. */
const ASK_MS = 120

function newTabId() {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24)
}

/** This page's id, once known: the channel answers for it from then on. */
let mine: string | null = null
let channel: BroadcastChannel | null = null

function listen() {
  if (channel || typeof BroadcastChannel === "undefined") return
  channel = new BroadcastChannel(CHANNEL)
  channel.onmessage = (event: MessageEvent<{ ask?: string }>) => {
    if (event.data.ask && event.data.ask === mine) channel?.postMessage({ taken: mine })
  }
}

/**
 * A duplicated tab starts with a copy of sessionStorage, so an id found there may
 * be another living tab's. A reload finds nobody answering for it; a duplicate
 * does, and takes a new one.
 */
export async function resolveTabId(): Promise<string> {
  if (mine) return mine
  listen()
  let id = sessionStorage.getItem(TAB_KEY)
  if (id && typeof BroadcastChannel !== "undefined") {
    const asked = id
    const asker = new BroadcastChannel(CHANNEL)
    const taken = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => done(false), ASK_MS)
      asker.onmessage = (event: MessageEvent<{ taken?: string }>) => {
        if (event.data.taken !== asked) return
        clearTimeout(timer)
        done(true)
      }
      asker.postMessage({ ask: asked })
    })
    asker.close()
    if (taken) id = null
  }
  id ??= newTabId()
  sessionStorage.setItem(TAB_KEY, id)
  mine = id
  return id
}

export interface CallFrame {
  type: "call"
  id: number
  name: string
  args: unknown
  project: string
}

/** Runs a tool on this tab's project. A call meant for another one never runs. */
export async function executeCall(frame: CallFrame, current: string | null, ctx: AgentContext): Promise<{ type: "result"; id: number; data: ToolResult }> {
  if (!current || frame.project !== current) {
    return { type: "result", id: frame.id, data: { isError: true, content: [{ type: "text", text: "вкладка переключается, повтори" }] } }
  }
  return { type: "result", id: frame.id, data: await runTool(frame.name, frame.args as Parameters<typeof runTool>[1], ctx) }
}

/** The server asks the tab to open a project: the old one is saved first, or the tab stays. */
export async function handleOpen(project: string, how: { flush: () => Promise<void>; navigate: (project: string) => void }): Promise<null | { type: "open-failed"; error: string }> {
  try {
    await how.flush()
  } catch (err) {
    return { type: "open-failed", error: `could not save the current project: ${(err as Error).message}` }
  }
  how.navigate(project)
  return null
}

export type TabFrame = CallFrame | { type: "open"; project: string } | { type: "none" } | { type: "claimed"; ok: boolean; tab: string } | { type: "projects"; tabs: { tab_id: string; project: string | null }[] }

/** The tab's control socket, reconnecting while the page lives. */
export class TabSocket {
  private ws: WebSocket | null = null
  private closed = false
  private retry = 0
  private readonly tab: string
  private readonly onFrame: (frame: TabFrame) => void
  private readonly onOpen: () => void

  constructor(tab: string, onFrame: (frame: TabFrame) => void, onOpen: () => void) {
    this.tab = tab
    this.onFrame = onFrame
    this.onOpen = onOpen
    this.connect()
  }

  private connect() {
    if (this.closed) return
    const proto = location.protocol === "https:" ? "wss" : "ws"
    const ws = new WebSocket(`${proto}://${location.host}/api/mcp/tabs/ws?tab=${encodeURIComponent(this.tab)}`)
    this.ws = ws
    ws.onopen = () => {
      this.retry = 0
      this.onOpen()
    }
    ws.onmessage = (event) => this.onFrame(JSON.parse(event.data as string) as TabFrame)
    ws.onclose = () => {
      if (this.ws === ws) setTimeout(() => this.connect(), Math.min(10_000, 500 * 2 ** this.retry++))
    }
  }

  send(frame: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame))
  }

  close() {
    this.closed = true
    this.ws?.close()
  }
}
