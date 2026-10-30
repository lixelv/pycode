import { useEffect, useRef, useState } from "react"

export interface DroppedFile {
  path: string
  bytes: Uint8Array
}

const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files")

/** The folder under the pointer: a folder row, a file row's folder, or the root. */
function folderAt(x: number, y: number): string {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-path]")
  if (!row) return ""
  const path = row.dataset.path ?? ""
  return row.dataset.kind === "dir" ? path : path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
}

/** Reads a dropped folder (or file) recursively. */
async function readEntry(entry: FileSystemEntry, prefix: string, out: DroppedFile[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    out.push({ path: prefix + file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
  } else if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    // readEntries returns the children in batches until an empty one.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
      if (!batch.length) break
      for (const child of batch) await readEntry(child, `${prefix}${entry.name}/`, out)
    }
  }
}

async function readDrop(data: DataTransfer): Promise<DroppedFile[]> {
  const out: DroppedFile[] = []
  const entries = [...data.items].map((item) => item.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e)
  if (entries.length) for (const entry of entries) await readEntry(entry, "", out)
  else for (const file of data.files) out.push({ path: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
  return out
}

/**
 * Files dragged onto the page from anywhere. While dragging, `target` is the
 * project folder under the pointer (rows carry data-path / data-kind).
 * When not `enabled`, drops are swallowed so the browser does not open the file.
 */
export function useFileDrop(enabled: boolean, onDrop: (folder: string, files: DroppedFile[]) => void) {
  const [target, setTarget] = useState<string | null>(null) // null: not dragging
  const depth = useRef(0)
  const handler = useRef(onDrop)
  useEffect(() => {
    handler.current = onDrop
  })

  useEffect(() => {
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      if (enabled) setTarget(folderAt(e.clientX, e.clientY))
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = enabled ? "copy" : "none"
      if (enabled) setTarget(folderAt(e.clientX, e.clientY))
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      if (--depth.current <= 0) {
        depth.current = 0
        setTarget(null)
      }
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setTarget(null)
      if (!enabled || !e.dataTransfer) return
      const folder = folderAt(e.clientX, e.clientY)
      void readDrop(e.dataTransfer).then((files) => files.length && handler.current(folder, files))
    }
    window.addEventListener("dragenter", enter)
    window.addEventListener("dragover", over)
    window.addEventListener("dragleave", leave)
    window.addEventListener("drop", drop)
    return () => {
      window.removeEventListener("dragenter", enter)
      window.removeEventListener("dragover", over)
      window.removeEventListener("dragleave", leave)
      window.removeEventListener("drop", drop)
    }
  }, [enabled])

  return { dragging: target !== null, target: target ?? "" }
}
