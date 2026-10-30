import { ChevronLeft, ChevronRight, Presentation as PresentationIcon, X } from "lucide-react"
import { useEffect, useState } from "react"

import { DocViewer } from "@/components/doc-viewer"
import { Button } from "@/components/ui/button"
import { useBlob } from "@/hooks/use-blob"
import { useI18n } from "@/lib/i18n"
import { docKindOf, metasOf } from "@/lib/project/project"
import type { ProjectStore } from "@/lib/project/store"

/** structure.state.presentation: who shows which document at which page. */
export interface PresentationState {
  path: string
  page: number
  /** Client id of the presenter. */
  by: number
}

/**
 * The presentation everyone sees: the presenter turns the pages (arrows,
 * space, click; Esc ends it), the others just watch. If the presenter is
 * gone, any admin can end it.
 */
export function Presentation({
  store,
  state,
  me,
  presenterName,
  presenterHere,
  admin,
  fetch,
  onPage,
  onStop,
}: {
  store: ProjectStore
  state: PresentationState
  me: number
  presenterName: string
  presenterHere: boolean
  admin: boolean
  fetch?: (hash: string) => Promise<Uint8Array>
  onPage: (page: number) => void
  onStop: () => void
}) {
  const { t } = useI18n()
  const meta = metasOf(store).get(state.path)
  const kind = docKindOf(state.path)
  const blob = useBlob(meta, fetch)
  const [pages, setPages] = useState(0)
  const presenting = state.by === me

  useEffect(() => {
    if (!presenting) return
    const go = (page: number) => onPage(Math.min(Math.max(1, page), pages || page))
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowDown" || e.key === "PageDown" || e.key === " ") go(state.page + 1)
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp" || e.key === "PageUp") go(state.page - 1)
      else if (e.key === "Escape") onStop()
      else return
      e.preventDefault()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [presenting, state.page, pages, onPage, onStop])

  return (
    <div role="dialog" aria-label={t("present.title")} className="fixed inset-0 z-50 flex animate-in flex-col bg-black duration-300 fade-in-0">
      <div
        className="min-h-0 flex-1"
        onClick={() => presenting && pages && state.page < pages && onPage(state.page + 1)}
      >
        {blob?.bytes && kind && (
          <DocViewer bytes={blob.bytes} kind={kind} page={state.page} onPages={setPages} className="bg-black [&_.doc-page]:p-0" />
        )}
      </div>
      <div className="flex h-11 shrink-0 items-center gap-3 px-4 text-xs text-white/60">
        <PresentationIcon className="size-3.5" />
        <span className="truncate">{presenting ? t("present.you") : t("present.by", { name: presenterName })}</span>
        <span className="ml-auto font-mono">
          {state.page} / {pages || "…"}
        </span>
        {presenting && (
          <>
            <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/10" aria-label={t("doc.prev")} disabled={state.page <= 1} onClick={() => onPage(state.page - 1)}>
              <ChevronLeft />
            </Button>
            <Button size="icon-sm" variant="ghost" className="text-white hover:bg-white/10" aria-label={t("doc.next")} disabled={!!pages && state.page >= pages} onClick={() => onPage(state.page + 1)}>
              <ChevronRight />
            </Button>
          </>
        )}
        {(presenting || (admin && !presenterHere)) && (
          <Button size="sm" variant="ghost" className="text-white hover:bg-white/10" onClick={onStop}>
            <X /> {t("present.stop")}
          </Button>
        )}
      </div>
    </div>
  )
}
