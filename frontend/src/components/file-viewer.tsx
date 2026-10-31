import { Download, File, Loader2 } from "lucide-react"
import { useEffect, useMemo, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n"
import { formatSize, useBlob } from "@/hooks/use-blob"
import { downloadBlob, nameOf } from "@/lib/project/project"
import type { FileMeta } from "@/lib/project/store"

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
  const image = meta.mime?.startsWith("image/")
  const url = useMemo(() => (blob?.bytes && image ? URL.createObjectURL(new Blob([blob.bytes as BlobPart], { type: meta.mime })) : null), [blob, image, meta.mime])
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])

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
