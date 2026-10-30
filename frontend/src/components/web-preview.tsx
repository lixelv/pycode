import { RotateCw, X } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { buildPage } from "@/lib/web-preview"

export interface WebRun {
  /** The file that was run (.html shown, .js run hidden). */
  path: string
  page: string
  /** Tags this run's console messages (other frames cannot fake them). */
  token: string
  visible: boolean
}

/**
 * A page in a sandboxed iframe: scripts allowed, but no same-origin access,
 * so student code cannot touch the app. The frame loads /preview.html (its
 * own, permissive CSP) and receives the page by postMessage; messages the
 * page sends back with `token` (console output, "loaded", see
 * lib/web-preview.ts) go to `onMessage`.
 */
export function SandboxFrame({
  page,
  token,
  title,
  className,
  onMessage,
}: {
  page: string
  token: string
  title: string
  className?: string
  onMessage?: (kind: "stdout" | "stderr" | "loaded", text: string) => void
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  const handler = useRef(onMessage)
  useEffect(() => {
    handler.current = onMessage
  })
  useEffect(() => {
    const listen = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const data = e.data as { pycodeReady?: boolean; pycode?: string; kind?: "stdout" | "stderr" | "loaded"; text?: string } | null
      // The frame is ready: give it the page.
      if (data?.pycodeReady) frame.current?.contentWindow?.postMessage({ pycodePage: page }, "*")
      if (data?.pycode !== token) return
      handler.current?.(data.kind ?? "stdout", String(data.text ?? ""))
    }
    window.addEventListener("message", listen)
    return () => window.removeEventListener("message", listen)
  }, [token, page])
  return <iframe ref={frame} key={token} title={title} sandbox="allow-scripts allow-modals allow-forms" src="/preview.html" className={className} />
}

/** Runs a page (Run on .html, under the editor) or a script (Run on .js, hidden). */
export function WebPreview({
  run,
  tabs,
  onOutput,
  onLoad,
  onReload,
  onClose,
}: {
  run: WebRun
  tabs: ReactNode
  onOutput: (kind: "stdout" | "stderr", text: string) => void
  onLoad: () => void
  onReload: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const frameEl = (
    <SandboxFrame
      key={run.token}
      page={run.page}
      token={run.token}
      title={run.path}
      onMessage={(kind, text) => (kind === "loaded" ? onLoad() : onOutput(kind, text))}
      className={cn(run.visible ? "min-h-0 w-full flex-1 bg-white" : "hidden")}
    />
  )
  if (!run.visible) return frameEl
  return (
    <section aria-label={t("web.title")} className="flex h-full flex-col bg-console">
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-console-border px-3">
        {tabs}
        <span className="truncate font-mono text-[11px] text-console-muted">{run.path}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <Button size="icon-xs" variant="ghost" aria-label={t("web.reload")} title={t("web.reload")} onClick={onReload} className="text-console-muted hover:bg-white/10 hover:text-console-foreground">
            <RotateCw />
          </Button>
          <Button size="icon-xs" variant="ghost" aria-label={t("console.hide")} onClick={onClose} className="text-console-muted hover:bg-white/10 hover:text-console-foreground">
            <X />
          </Button>
        </div>
      </header>
      {frameEl}
    </section>
  )
}

/**
 * The open HTML file beside (or instead of) the editor, rebuilt shortly
 * after each change. The page's console is not shown here (Run shows it).
 */
export function LivePagePreview({ path, source, files }: { path: string; source: string; files: () => Promise<Record<string, string | Uint8Array>> }) {
  const { t } = useI18n()
  const [shown, setShown] = useState<{ page: string; token: string } | null>(null)
  const latest = useRef(files)
  useEffect(() => {
    latest.current = files
  })
  useEffect(() => {
    let live = true
    const timer = setTimeout(() => {
      void latest.current().then((all) => {
        if (!live) return
        const token = crypto.randomUUID()
        setShown({ page: buildPage({ ...all, [path]: source }, path, token), token })
      })
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [path, source])
  return (
    <div className="flex size-full bg-white">
      {shown && <SandboxFrame key={shown.token} page={shown.page} token={shown.token} title={t("web.title")} className="size-full" />}
    </div>
  )
}
