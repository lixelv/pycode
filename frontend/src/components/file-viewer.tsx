import { Download, File, Loader2 } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n"
import { ensureBlob } from "@/lib/project/blobs"
import { downloadBlob, nameOf } from "@/lib/project/project"
import type { FileMeta } from "@/lib/project/store"

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Loads a binary file's bytes (from this browser or the session). */
export function useBlob(meta: FileMeta | undefined, fetch?: (hash: string) => Promise<Uint8Array>) {
  const [state, setState] = useState<{ hash: string; bytes: Uint8Array | null; error: boolean } | null>(null)
  const hash = meta?.hash
  useEffect(() => {
    if (!hash) return
    let live = true
    ensureBlob(hash, fetch).then(
      (bytes) => live && setState({ hash, bytes, error: false }),
      () => live && setState({ hash, bytes: null, error: true }),
    )
    return () => {
      live = false
    }
  }, [hash, fetch])
  return state?.hash === hash ? state : null
}

/**
 * A binary file in place of the editor: pictures are shown, documents use
 * their viewer (`render`), anything else offers a download.
 */
export function FileViewer({
  path,
  meta,
  fetch,
  render,
}: {
  path: string
  meta: FileMeta
  fetch?: (hash: string) => Promise<Uint8Array>
  render?: (bytes: Uint8Array) => ReactNode
}) {
  const { t } = useI18n()
  const blob = useBlob(meta, fetch)
  const [url, setUrl] = useState<string | null>(null)
  const image = meta.mime?.startsWith("image/")
  useEffect(() => {
    if (!blob?.bytes || !image) return
    const u = URL.createObjectURL(new Blob([blob.bytes as BlobPart], { type: meta.mime }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [blob, image, meta.mime])

  if (!blob) {
    return (
      <Center>
        <Loader2 className="size-5 animate-spin" /> {t("viewer.loading")}
      </Center>
    )
  }
  if (!blob.bytes) return <Center>{t("viewer.missing")}</Center>
  if (render) return <>{render(blob.bytes)}</>
  if (image && url) {
    return (
      <div className="flex size-full items-center justify-center overflow-auto bg-[repeating-conic-gradient(var(--muted)_0_25%,transparent_0_50%)] bg-[length:16px_16px] p-6">
        <img src={url} alt={nameOf(path)} className="max-h-full max-w-full object-contain shadow-lg" />
      </div>
    )
  }
  return (
    <Center>
      <File className="size-10 text-muted-foreground" />
      <span className="font-mono text-sm text-foreground">{nameOf(path)}</span>
      <span>{t("viewer.binary", { size: formatSize(meta.size) })}</span>
      <Button variant="outline" size="sm" onClick={() => downloadBlob(blob.bytes!, nameOf(path), meta.mime)}>
        <Download /> {t("viewer.download")}
      </Button>
    </Center>
  )
}

function Center({ children }: { children: ReactNode }) {
  return <div className="flex size-full flex-col items-center justify-center gap-3 bg-background text-sm text-muted-foreground">{children}</div>
}
