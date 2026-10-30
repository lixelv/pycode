import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import type { DocKind } from "@/lib/project/project"

/** One open document: renders page `page` (1-based) to fit `box`. */
interface Doc {
  pages: number
  render(page: number, box: HTMLElement): Promise<void>
  destroy(): void
}

async function openPdf(bytes: Uint8Array): Promise<Doc> {
  const pdfjs = await import("pdfjs-dist")
  const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default
  const loading = pdfjs.getDocument({ data: bytes.slice() })
  const pdf = await loading.promise
  let task: { cancel(): void } | null = null
  return {
    pages: pdf.numPages,
    async render(n, box) {
      task?.cancel()
      const page = await pdf.getPage(n)
      const base = page.getViewport({ scale: 1 })
      const scale = Math.min(box.clientWidth / base.width, box.clientHeight / base.height)
      const viewport = page.getViewport({ scale: scale * devicePixelRatio })
      const canvas = document.createElement("canvas")
      canvas.width = viewport.width
      canvas.height = viewport.height
      canvas.style.width = `${viewport.width / devicePixelRatio}px`
      canvas.style.height = `${viewport.height / devicePixelRatio}px`
      canvas.className = "bg-white shadow-lg"
      const t = page.render({ canvas, viewport })
      task = t
      await t.promise.catch(() => {})
      if (task === t) box.replaceChildren(canvas)
    },
    destroy: () => void loading.destroy(),
  }
}

async function openPptx(bytes: Uint8Array, box: HTMLElement): Promise<Doc> {
  const { init } = await import("pptx-preview")
  let viewer: ReturnType<typeof init> | null = null
  let size = ""
  let ratio = 0 // slide height / width
  const load = async () => {
    viewer?.destroy()
    box.replaceChildren()
    if (!ratio) {
      const probe = init(document.createElement("div"), { width: 100, height: 100, mode: "slide" })
      const pptx = await probe.load(bytes.slice().buffer as ArrayBuffer)
      ratio = pptx.height / pptx.width || 0.5625
      probe.destroy()
    }
    // Fit the slide inside the box (minus its padding), keeping its shape.
    const width = Math.max(100, Math.min(box.clientWidth - 32, (box.clientHeight - 32) / ratio))
    viewer = init(box, { width, height: width * ratio, mode: "slide" })
    size = `${box.clientWidth}x${box.clientHeight}`
    await viewer.preview(bytes.slice().buffer as ArrayBuffer)
  }
  await load()
  return {
    pages: viewer!.slideCount,
    async render(n) {
      // The renderer is sized when created: make a new one when the box changes.
      if (size !== `${box.clientWidth}x${box.clientHeight}`) await load()
      viewer!.removeCurrentSlide()
      viewer!.currentIndex = n - 1
      viewer!.renderSingleSlide(n - 1)
    },
    destroy: () => viewer?.destroy(),
  }
}

/**
 * A PDF or PowerPoint file, one page at a time. The page is controlled by
 * the parent (so a presentation can drive it); without `onPage` there is no
 * navigation.
 */
export function DocViewer({
  bytes,
  kind,
  page,
  onPage,
  onPages,
  className,
}: {
  bytes: Uint8Array
  kind: DocKind
  page: number
  onPage?: (page: number) => void
  onPages?: (pages: number) => void
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const [doc, setDoc] = useState<Doc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pagesRef = useRef(onPages)
  useEffect(() => {
    pagesRef.current = onPages
  })

  useEffect(() => {
    let live = true
    let opened: Doc | null = null
    const el = box.current!
    setError(null)
    ;(kind === "pdf" ? openPdf(bytes) : openPptx(bytes, el)).then(
      (d) => {
        opened = d
        if (!live) return d.destroy()
        setDoc(d)
        pagesRef.current?.(d.pages)
      },
      (err: Error) => live && setError(err.message),
    )
    return () => {
      live = false
      opened?.destroy()
      setDoc(null)
    }
  }, [bytes, kind])

  // Render the page now and whenever the box is resized.
  useEffect(() => {
    if (!doc || !box.current) return
    const el = box.current
    const n = Math.min(Math.max(1, page), doc.pages)
    void doc.render(n, el)
    let timer = 0
    const ro = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void doc.render(n, el), 120)
    })
    ro.observe(el)
    return () => {
      ro.disconnect()
      window.clearTimeout(timer)
    }
  }, [doc, page])

  const pages = doc?.pages ?? 0
  return (
    <div className={cn("relative flex size-full flex-col bg-muted/40", className)}>
      <div ref={box} className="doc-page flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4" />
      {!doc && !error && (
        <div className="absolute inset-0 flex items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      )}
      {error && <div className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-muted-foreground">{error}</div>}
      {onPage && pages > 0 && (
        <div className="flex h-10 shrink-0 items-center justify-center gap-2 border-t border-border bg-background">
          <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            <ChevronLeft />
          </Button>
          <span className="min-w-16 text-center font-mono text-xs text-muted-foreground">
            {page} / {pages}
          </span>
          <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}>
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  )
}
