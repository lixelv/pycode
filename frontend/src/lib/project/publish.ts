import * as Y from "yjs"

import type { FileMeta } from "./store"

/*
 * Where a file's objects lie under projects/<id>/ in S3. What a stranger may read
 * is decided by this prefix alone, since the server never reads a project:
 *   public   anyone, once the project is public
 *   hidden   the owner; a copy of the project gets it as sealed
 *   sealed   the owner of a copy, for tests only; written by the server alone
 *   private  the owner; never copied (role folders may hold students' work)
 */
export type Placement = "public" | "hidden" | "sealed" | "private"

export interface ManifestEntry {
  path: string
  id: string
  kind: FileMeta["kind"]
  size: number
  hash?: string
  mime?: string
}

export function placementOf(path: string, meta: FileMeta, folders: Record<string, string>): Placement {
  if (meta.sealed) return "sealed"
  if (Object.keys(folders).some((folder) => path.startsWith(folder + "/"))) return "private"
  return meta.hidden ? "hidden" : "public"
}

/**
 * The structure a stranger gets: public files, what running needs, nothing else.
 * Built in a clean document, since the history of the real one holds every name
 * it ever had. It is never merged back into the owner's.
 */
export function publicStructure(structure: Y.Doc): Uint8Array {
  const folders = structure.getMap<string>("folders").toJSON() as Record<string, string>
  const out = new Y.Doc()
  out.transact(() => {
    const files = out.getMap<FileMeta>("files")
    structure.getMap<FileMeta>("files").forEach((meta, path) => {
      if (placementOf(path, meta, folders) === "public") files.set(path, meta)
    })
    const dirs = out.getMap<true>("dirs")
    const closed = (path: string) => Object.keys(folders).some((folder) => path === folder || path.startsWith(folder + "/"))
    for (const dir of structure.getMap<true>("dirs").keys()) if (!closed(dir)) dirs.set(dir, true)
    out.getArray("packages").push(structure.getArray("packages").toArray())
    out.getArray("cppPackages").push(structure.getArray("cppPackages").toArray())
    const languages = structure.getMap("state").get("languages")
    if (languages !== undefined) out.getMap("state").set("languages", languages)
  })
  const bytes = Y.encodeStateAsUpdate(out)
  out.destroy()
  return bytes
}

/** Hidden files as a copy needs them: enough to find a test by its path. */
export function hiddenManifest(structure: Y.Doc): ManifestEntry[] {
  const folders = structure.getMap<string>("folders").toJSON() as Record<string, string>
  const out: ManifestEntry[] = []
  structure.getMap<FileMeta>("files").forEach((meta, path) => {
    if (placementOf(path, meta, folders) !== "hidden") return
    out.push({ path, id: meta.id, kind: meta.kind, size: meta.size, ...(meta.hash ? { hash: meta.hash } : {}), ...(meta.mime ? { mime: meta.mime } : {}) })
  })
  return out
}
