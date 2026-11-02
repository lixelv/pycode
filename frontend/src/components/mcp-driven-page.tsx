import { Bot, Copy, List, RefreshCw } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { handleOpen, resolveTabId, TabSocket, type CallFrame, type TabFrame } from "@/lib/agent/tab-socket"
import { useI18n } from "@/lib/i18n"
import { CloudError } from "@/lib/project/cloud"
import { openPage, type PageProject } from "@/lib/project/page"

import { ProjectList, ProjectMissing } from "./project-list"

const TOKEN_KEY = "polycode:mcp-token"
const PROJECT_KEY = "polycode:mcp-project"

const load = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

async function issueToken() {
  const res = await fetch("/api/mcp/token", { method: "POST" })
  if (!res.ok) throw new Error("could not issue a token")
  const { token } = (await res.json()) as { token: string }
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // storage unavailable: shown only now
  }
  return token
}

/** The address and token an agent connects with. The server keeps only the token's hash, so the browser keeps the token. */
function McpAccess() {
  const { t } = useI18n()
  const [token, setToken] = useState<string | null>(() => load(TOKEN_KEY))
  const [sure, setSure] = useState(false)
  const address = `${location.origin}/mcp`

  useEffect(() => {
    if (token) return
    void fetch("/api/mcp/token")
      .then((r) => r.json() as Promise<{ exists: boolean }>)
      .then(async ({ exists }) => {
        if (!exists) setToken(await issueToken())
      })
      .catch(() => {})
  }, [token])

  const copy = (value: string) => void navigator.clipboard?.writeText(value).then(() => toast.success(t("mcp.copied")))
  const reissue = async () => {
    if (!sure) return setSure(true)
    setSure(false)
    setToken(await issueToken().catch((err: Error) => (toast.error(err.message), token)))
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="inline-flex items-center gap-1 font-medium">
        <Bot className="size-3.5" /> {t("mcp.tab")}
      </span>
      <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
        {t("mcp.address")} <code className="truncate font-mono text-foreground">{address}</code>
        <Button variant="ghost" size="xs" aria-label={t("mcp.copyAddress")} onClick={() => copy(address)}>
          <Copy />
        </Button>
      </span>
      <span className="inline-flex min-w-0 items-center gap-1 text-muted-foreground">
        {t("mcp.token")} <code className="max-w-40 truncate font-mono text-foreground">{token ?? t("mcp.tokenHidden")}</code>
        {token && (
          <Button variant="ghost" size="xs" aria-label={t("mcp.copyToken")} onClick={() => copy(token)}>
            <Copy />
          </Button>
        )}
      </span>
      <Button variant={sure ? "destructive" : "ghost"} size="xs" onBlur={() => setSure(false)} onClick={() => void reissue()}>
        <RefreshCw /> {t(sure ? "mcp.reissueSure" : "mcp.reissue")}
      </Button>
    </div>
  )
}

export interface McpTab {
  /** The workspace says how to run an agent's calls; null while it cannot. */
  setCallHandler: (run: ((frame: CallFrame) => Promise<unknown>) | null) => void
}

const Workspace = lazy(() => import("@/App").then((m) => ({ default: m.Workspace })))

/**
 * /mcp-driven. A tab with an id, holding at most one project: the server keeps
 * a project to one such tab. Changing a project is a page load, here as everywhere.
 */
export function McpDrivenPage() {
  const { t } = useI18n()
  const [tabId, setTabId] = useState<string | null>(null)
  const [page, setPage] = useState<PageProject | null>(null)
  const [missing, setMissing] = useState(false)
  const [loading, setLoading] = useState(() => !!wantedProject())
  const [busy, setBusy] = useState<Record<string, string>>({})
  const socket = useRef<TabSocket | null>(null)
  const pageRef = useRef<PageProject | null>(null)
  const wanted = useRef<string | null>(wantedProject())
  const handler = useRef<((frame: CallFrame) => Promise<unknown>) | null>(null)
  const pending = useRef<CallFrame[]>([])

  const goTo = useCallback((project: string | null) => {
    try {
      if (project) sessionStorage.setItem(PROJECT_KEY, project)
      else sessionStorage.removeItem(PROJECT_KEY)
    } catch {
      // storage unavailable: the address still says it
    }
    location.assign(project ? `/mcp-driven?project=${project}` : "/mcp-driven")
  }, [])

  const ready = useCallback((id: string | null) => socket.current?.send({ type: "ready", project: id }), [])

  const onFrame = useCallback(
    (frame: TabFrame) => {
      switch (frame.type) {
        case "claimed": {
          const id = wanted.current
          if (!id) return
          if (!frame.ok) {
            // Open in another tab, or not ours: this one shows the list.
            if (pageRef.current) return goTo(null) // it was taken while we were away
            wanted.current = null
            try {
              sessionStorage.removeItem(PROJECT_KEY)
            } catch {
              // storage unavailable
            }
            history.replaceState(null, "", "/mcp-driven")
            setLoading(false)
            return
          }
          if (pageRef.current) return ready(id)
          void openPage(id).then(
            (opened) => {
              pageRef.current = opened
              setPage(opened)
              setLoading(false)
              ready(id)
            },
            (err) => {
              if (err instanceof CloudError && err.status === 404) setMissing(true)
              else toast.error((err as Error).message)
              setLoading(false)
              // An agent may be waiting for this opening.
              socket.current?.send({ type: "open-failed", error: (err as Error).message })
              socket.current?.send({ type: "release" })
            },
          )
          return
        }
        case "projects": {
          const held: Record<string, string> = {}
          for (const tab of frame.tabs) if (tab.project) held[tab.project] = tab.tab_id
          setBusy(held)
          return
        }
        case "call": {
          if (handler.current) void handler.current(frame).then((answer) => socket.current?.send(answer))
          else pending.current.push(frame)
          return
        }
        case "open": {
          const current = pageRef.current
          void handleOpen(frame.project, {
            flush: async () => {
              if (current?.kind === "own") await current.saver.flush()
            },
            navigate: goTo,
          }).then((reply) => {
            if (reply) socket.current?.send(reply)
          })
          return
        }
        case "none":
          goTo(null)
      }
    },
    [goTo, ready],
  )

  useEffect(() => {
    let live = true
    void resolveTabId().then((id) => {
      if (!live) return
      setTabId(id)
      socket.current = new TabSocket(id, onFrame, () => {
        if (wanted.current) socket.current?.send({ type: "claim", project: wanted.current })
        else ready(null)
      })
    })
    return () => {
      live = false
      socket.current?.close()
    }
  }, [onFrame, ready])

  const mcpTab = useMemo<McpTab>(
    () => ({
      setCallHandler: (run) => {
        handler.current = run
        if (!run) return
        for (const frame of pending.current.splice(0)) void run(frame).then((answer) => socket.current?.send(answer))
      },
    }),
    [],
  )

  const leave = () => {
    socket.current?.send({ type: "release" })
    goTo(null)
  }

  if (page) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-border bg-background px-3 py-1 text-foreground">
          <McpAccess />
          <Button variant="outline" size="xs" className="ml-auto" onClick={leave}>
            <List /> {t("mcp.toList")}
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          <Suspense fallback={<div className="h-full bg-background" />}>
            <Workspace page={page} mcpTab={mcpTab} />
          </Suspense>
        </div>
      </div>
    )
  }
  if (missing) return <ProjectMissing />
  return (
    <div className="flex h-full flex-col items-center gap-6 overflow-auto bg-background p-6 text-foreground" data-tab={tabId ?? undefined}>
      <h1 className="pt-8 text-xl font-semibold">{t("mcp.title")}</h1>
      <div className="w-full max-w-2xl rounded-lg border border-border p-3">
        <McpAccess />
        <p className="mt-2 text-xs text-muted-foreground">{t("mcp.hint")}</p>
      </div>
      {loading ? <div className="text-sm text-muted-foreground">{t("mcp.opening")}</div> : <ProjectList busy={busy} onOpen={goTo} />}
    </div>
  )
}

/** The project this tab should hold: asked for in the address, or its own from before a reload. */
function wantedProject(): string | null {
  const asked = new URLSearchParams(location.search).get("project")
  if (asked) return asked
  try {
    return sessionStorage.getItem(PROJECT_KEY)
  } catch {
    return null
  }
}
