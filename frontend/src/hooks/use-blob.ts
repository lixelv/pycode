import { useEffect, useState } from "react"

import { ensureBlob } from "@/lib/project/blobs"
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
