import DOMPurify from "dompurify"
import { marked } from "marked"
import { useEffect, useMemo, useRef, useState } from "react"

import { useI18n } from "@/lib/i18n"
import { ensureBlob } from "@/lib/project/blobs"
import { cleanPath, metasOf, parentOf } from "@/lib/project/project"
import type { ProjectStore } from "@/lib/project/store"

/**
 * Rendered Markdown, always on the dark console surface, live as the file
 * is typed. Pictures from the project (`![](img/a.png)`) are shown from
 * the project's files.
 */
export function MarkdownPreview({
  path,
  source,
  store,
  fetch,
}: {
  path: string
  source: string
  store: ProjectStore
  fetch?: (hash: string) => Promise<Uint8Array>
}) {
  const { t } = useI18n()
  const debounced = useDebounced(source, 150)
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(debounced, { async: false, gfm: true }) as string), [debounced])
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const urls: string[] = []
    let live = true
    for (const img of box.current?.querySelectorAll("img") ?? []) {
      const src = img.getAttribute("src") ?? ""
      if (/^[a-z]+:|^\/\//i.test(src)) continue
      const dir = parentOf(path)
      const target = cleanPath(src.startsWith("/") ? src : dir ? `${dir}/${src}` : src)
      const meta = target ? metasOf(store).get(target) : undefined
      if (!meta?.hash) continue
      void ensureBlob(meta.hash, fetch).then((bytes) => {
        if (!live) return
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: meta.mime }))
        urls.push(url)
        img.src = url
      })
    }
    return () => {
      live = false
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [html, path, store, fetch])

  return (
    <section aria-label={t("md.previewLabel")} className="h-full overflow-auto bg-console text-console-foreground">
      <div ref={box} className="markdown-body px-6 py-5" dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  )
}

function useDebounced<T>(value: T, ms: number): T {
  const [state, setState] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setState(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return state
}
