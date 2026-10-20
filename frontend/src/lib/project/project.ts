import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { IndexeddbPersistence } from "y-indexeddb"
import * as Y from "yjs"

import type { PackageEntry } from "@/hooks/use-packages"
import { DEFAULT_CODE } from "@/lib/storage"

/*
 * A project is a Y.Doc, the same structure alone and in a live session:
 *   files     Y.Map<Y.Text>   path ("src/utils.py") -> content
 *   dirs      Y.Map<true>     folders created explicitly (they may be empty)
 *   packages  Y.Array         PackageEntry
 *   terminal  Y.Text          console output, runs carry {k: ChunkKind}
 *   run       Y.Map           status, exit, executorClient, draft (input being typed)
 */
export const filesOf = (doc: Y.Doc) => doc.getMap<Y.Text>("files")
export const dirsOf = (doc: Y.Doc) => doc.getMap<true>("dirs")

export const DEFAULT_FILE = "main.py"

export type Language = "python" | "json" | "yaml" | "markdown" | "plaintext"

export function languageOf(path: string): Language {
  const ext = path.toLowerCase().split(".").pop() ?? ""
  if (ext === "py" || ext === "pyw") return "python"
  if (ext === "json") return "json"
  if (ext === "yaml" || ext === "yml") return "yaml"
  if (ext === "md" || ext === "markdown") return "markdown"
  return "plaintext"
}

/** Normalizes a user-typed path: forward slashes, no leading/trailing or empty parts. */
export function cleanPath(raw: string): string | null {
  const parts = raw.replace(/\\/g, "/").split("/").map((p) => p.trim()).filter(Boolean)
  if (!parts.length || parts.some((p) => p === "." || p === "..")) return null
  return parts.join("/")
}

export const parentOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
export const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1)

export function createFile(doc: Y.Doc, path: string, content = "") {
  const files = filesOf(doc)
  if (files.has(path)) return
  doc.transact(() => {
    const text = new Y.Text()
    text.insert(0, content)
    files.set(path, text)
  })
}

export function createDir(doc: Y.Doc, path: string) {
  dirsOf(doc).set(path, true)
}

/** Deletes a file, or a folder with everything inside it. */
export function deletePath(doc: Y.Doc, path: string) {
  doc.transact(() => {
    const files = filesOf(doc)
    const dirs = dirsOf(doc)
    for (const key of [...files.keys()]) if (key === path || key.startsWith(path + "/")) files.delete(key)
    for (const key of [...dirs.keys()]) if (key === path || key.startsWith(path + "/")) dirs.delete(key)
  })
}

export function exists(doc: Y.Doc, path: string) {
  if (filesOf(doc).has(path) || dirsOf(doc).has(path)) return true
  return [...filesOf(doc).keys()].some((k) => k.startsWith(path + "/"))
}

/** Every folder, explicit or implied by a file inside it. */
export function allDirs(doc: Y.Doc): string[] {
  const set = new Set<string>(dirsOf(doc).keys())
  for (const path of filesOf(doc).keys()) {
    for (let p = parentOf(path); p; p = parentOf(p)) set.add(p)
  }
  return [...set].sort()
}

export function snapshotFiles(doc: Y.Doc): Record<string, string> {
  const out: Record<string, string> = {}
  filesOf(doc).forEach((text, path) => (out[path] = text.toString()))
  return out
}

/** Replaces the whole project content (files, folders, packages). */
export function replaceProject(doc: Y.Doc, files: Record<string, string>, dirs: string[] = [], packages: PackageEntry[] = []) {
  doc.transact(() => {
    const f = filesOf(doc)
    const d = dirsOf(doc)
    for (const k of [...f.keys()]) f.delete(k)
    for (const k of [...d.keys()]) d.delete(k)
    for (const [path, content] of Object.entries(files)) {
      const text = new Y.Text()
      text.insert(0, content)
      f.set(path, text)
    }
    for (const dir of dirs) d.set(dir, true)
    const pkgs = doc.getArray<PackageEntry>("packages")
    pkgs.delete(0, pkgs.length)
    pkgs.push(packages)
    const term = doc.getText("terminal")
    term.delete(0, term.length)
    doc.getMap("run").clear()
  })
}

export function resetProject(doc: Y.Doc) {
  replaceProject(doc, { [DEFAULT_FILE]: DEFAULT_CODE })
}

// ---- archive --------------------------------------------------------------

const MAX_ARCHIVE_FILE = 5 * 1024 * 1024

export function exportZip(doc: Y.Doc): Uint8Array {
  const entries: Record<string, Uint8Array> = {}
  for (const [path, content] of Object.entries(snapshotFiles(doc))) entries[path] = strToU8(content)
  // Keep empty folders.
  for (const dir of dirsOf(doc).keys()) {
    if (![...filesOf(doc).keys()].some((p) => p.startsWith(dir + "/"))) entries[dir + "/"] = new Uint8Array()
  }
  return zipSync(entries, { level: 6 })
}

/**
 * Reads a .zip into files and folders. Every file is read as UTF-8 text;
 * unknown or binary files simply show as (unreadable) text.
 */
export function importZip(data: Uint8Array): { files: Record<string, string>; dirs: string[] } {
  const raw = unzipSync(data)
  const files: Record<string, string> = {}
  const dirs: string[] = []
  const paths = Object.keys(raw).filter((p) => !p.startsWith("__MACOSX/") && !p.split("/").some((part) => part === ".DS_Store"))
  // A zip of one folder ("project/…") is opened as that folder's content.
  const top = new Set(paths.map((p) => p.split("/")[0]))
  const strip = top.size === 1 && paths.every((p) => p.includes("/")) ? [...top][0] + "/" : ""
  for (const original of paths) {
    const rel = original.slice(strip.length)
    if (!rel) continue
    if (rel.endsWith("/")) {
      const dir = cleanPath(rel)
      if (dir) dirs.push(dir)
      continue
    }
    const path = cleanPath(rel)
    if (!path) continue
    const bytes = raw[original]
    files[path] = bytes.length > MAX_ARCHIVE_FILE ? `(file too large to open: ${bytes.length} bytes)` : strFromU8(bytes, false)
  }
  return { files, dirs }
}

// ---- the local project -------------------------------------------------------

const LOCAL_DB = "python-coder:project"
const LEGACY_PACKAGES = "python-coder:packages"

export interface LocalProject {
  doc: Y.Doc
  ready: Promise<void>
}

let local: LocalProject | null = null

/** The user's own project, saved in IndexedDB. */
export function localProject(): LocalProject {
  if (local) return local
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(LOCAL_DB, doc)
  const ready = new Promise<void>((resolve) => {
    persistence.once("synced", () => {
      if (filesOf(doc).size === 0) {
        // First start: bring over the code and packages kept by older versions.
        let legacyCode: string | null = null
        let legacyPackages: PackageEntry[] = []
        try {
          legacyCode = localStorage.getItem("python-coder:code")
          legacyPackages = JSON.parse(localStorage.getItem(LEGACY_PACKAGES) ?? "[]")
        } catch {
          // storage unavailable
        }
        replaceProject(doc, { [DEFAULT_FILE]: legacyCode ?? DEFAULT_CODE }, [], legacyPackages)
      }
      // A run cannot survive a reload.
      const run = doc.getMap("run")
      if (run.get("status") && run.get("status") !== "finished" && run.get("status") !== "idle") run.set("status", "idle")
      resolve()
    })
  })
  local = { doc, ready }
  return local
}

export function downloadBlob(data: Uint8Array, name: string, type = "application/zip") {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }))
  const a = document.createElement("a")
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * Renames a file or a folder (with everything inside). Yjs types cannot be
 * moved, so contents are copied into new texts under the new paths.
 * Returns how a path maps after the rename (for the open file).
 */
export function renamePath(doc: Y.Doc, from: string, to: string): (path: string) => string {
  const map = (path: string) => (path === from ? to : path.startsWith(from + "/") ? to + path.slice(from.length) : path)
  doc.transact(() => {
    const files = filesOf(doc)
    const dirs = dirsOf(doc)
    for (const key of [...files.keys()]) {
      const next = map(key)
      if (next === key) continue
      const text = new Y.Text()
      text.insert(0, files.get(key)!.toString())
      files.delete(key)
      files.set(next, text)
    }
    for (const key of [...dirs.keys()]) {
      const next = map(key)
      if (next === key) continue
      dirs.delete(key)
      dirs.set(next, true)
    }
  })
  return map
}
