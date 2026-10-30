import { RotateCw, X } from "lucide-react"
import { useEffect, useRef } from "react"

import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"

export interface WebRun {
  /** The file that was run (.html shown, .js run hidden). */
  path: string
  page: string
  /** Tags this run's console messages (other frames cannot fake them). */
  token: string
  visible: boolean
}

/**
 * Runs a page in a sandboxed iframe: scripts allowed, but no same-origin
 * access, so student code cannot touch the app. The frame loads
 * /preview.html (its own, permissive CSP) and receives the page by
 * postMessage; console output comes back the same way (lib/web-preview.ts).
 */
export function WebPreview({
  run,
  tabs,
  onOutput,
  onLoad,
  onReload,
  onClose,
}: {
  run: WebRun
  tabs: React.ReactNode
  onOutput: (kind: "stdout" | "stderr", text: string) => void
  onLoad: () => void
  onReload: () => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const frame = useRef<HTMLIFrameElement>(null)
  const output = useRef(onOutput)
  const loaded = useRef(onLoad)
  useEffect(() => {
    output.current = onOutput
    loaded.current = onLoad
  })
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return
      const data = e.data as { pycodeReady?: boolean; pycode?: string; kind?: "stdout" | "stderr" | "loaded"; text?: string } | null
      // The frame is ready: give it the page.
      if (data?.pycodeReady) frame.current?.contentWindow?.postMessage({ pycodePage: run.page }, "*")
      if (data?.pycode !== run.token) return
      if (data.kind === "loaded") loaded.current()
      else output.current(data.kind === "stderr" ? "stderr" : "stdout", String(data.text ?? ""))
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [run.token, run.page])

  const frameEl = (
    <iframe
      ref={frame}
      key={run.token}
      title={run.path}
      sandbox="allow-scripts allow-modals allow-forms"
      src="/preview.html"
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
