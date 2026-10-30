import { strFromU8, strToU8, unzipSync, zipSync } from "fflate"
import { IndexeddbPersistence } from "y-indexeddb"
import { Doc as YDoc } from "yjs"
import type * as Y from "yjs"

import type { PackageEntry } from "@/hooks/use-packages"
import { DEFAULT_CODE } from "@/lib/storage"

import { isTest, parseEnv, renameRules, RESERVED, runVisible, serializeEnv, type EnvRules, type Rules } from "./access"
import { ensureBlob, putBlob, sha256 } from "./blobs"
import { ProjectStore, type FileMeta } from "./store"

/*
 * A project is a ProjectStore (see store.ts). Paths live in
 * structure.files (path -> FileMeta); a text file's content is the Y.Text
 * "t" of its own document f:<id>, so a rename only moves the metadata.
 */
export const metasOf = (s: ProjectStore) => s.structure.getMap<FileMeta>("files")
export const dirsOf = (s: ProjectStore) => s.structure.getMap<true>("dirs")
export const packagesOf = (s: ProjectStore) => s.structure.getArray<PackageEntry>("packages")

/** The shared text of a text file, or null (no such file, or binary). */
export function textOf(s: ProjectStore, path: string): Y.Text | null {
  const meta = metasOf(s).get(path)
  return meta?.kind === "text" ? s.doc(`f:${meta.id}`).getText("t") : null
}

/** The access rules as they stand in the structure document. */
export function rulesOf(s: ProjectStore): Rules {
  return {
    files: metasOf(s).toJSON() as Record<string, FileMeta>,
    folders: foldersOf(s).toJSON() as Record<string, string>,
    frozen: !!stateOf(s).get("frozen"),
  }
}

export const foldersOf = (s: ProjectStore) => s.structure.getMap<string>("folders")
export const rolesOf = (s: ProjectStore) => s.structure.getMap<"read" | "write">("roles")
export const stateOf = (s: ProjectStore) => s.structure.getMap<unknown>("state")

export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16)

export const DEFAULT_FILE = "main.py"

export type Language = "python" | "json" | "yaml" | "markdown" | "html" | "css" | "javascript" | "plaintext"

export function languageOf(path: string): Language {
  const ext = path.toLowerCase().split(".").pop() ?? ""
  if (ext === "py" || ext === "pyw") return "python"
  if (ext === "json") return "json"
  if (ext === "yaml" || ext === "yml") return "yaml"
  if (ext === "md" || ext === "markdown") return "markdown"
  if (ext === "html" || ext === "htm") return "html"
  if (ext === "css") return "css"
  if (ext === "js" || ext === "mjs") return "javascript"
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

/** `flags` overrides the default (tests are created hidden). */
export function createFile(s: ProjectStore, path: string, content = "", flags?: Pick<FileMeta, "protected" | "hidden">) {
  const metas = metasOf(s)
  if (metas.has(path)) return
  const id = newId()
  // Tests are hidden from students until an admin shows them.
  metas.set(path, { id, kind: "text", size: content.length, ...(flags ?? (isTest(path) ? { hidden: true as const } : {})) })
  if (content) s.doc(`f:${id}`).getText("t").insert(0, content)
}

/** Sets or clears a file's protected/hidden flag. */
export function setFlag(s: ProjectStore, path: string, flag: "protected" | "hidden", on: boolean) {
  const metas = metasOf(s)
  const meta = metas.get(path)
  if (!meta) return
  const next = { ...meta }
  if (on) next[flag] = true
  else delete next[flag]
  metas.set(path, next)
}

/** Gives a folder to a role (only it and admins see inside), or makes it public (null). */
export function setFolderRole(s: ProjectStore, path: string, role: string | null) {
  if (role) foldersOf(s).set(path, role)
  else foldersOf(s).delete(path)
}

export function createDir(s: ProjectStore, path: string) {
  dirsOf(s).set(path, true)
}

/** Deletes a file, or a folder with everything inside it. */
export function deletePath(s: ProjectStore, path: string) {
  s.structure.transact(() => {
    const metas = metasOf(s)
    const dirs = dirsOf(s)
    for (const key of [...metas.keys()]) if (key === path || key.startsWith(path + "/")) metas.delete(key)
    for (const key of [...dirs.keys()]) if (key === path || key.startsWith(path + "/")) dirs.delete(key)
    const folders = foldersOf(s)
    for (const key of [...folders.keys()]) if (key === path || key.startsWith(path + "/")) folders.delete(key)
  })
}

export function exists(s: ProjectStore, path: string) {
  if (metasOf(s).has(path) || dirsOf(s).has(path)) return true
  return [...metasOf(s).keys()].some((k) => k.startsWith(path + "/"))
}

/** Every folder, explicit or implied by a file inside it. */
export function allDirs(s: ProjectStore): string[] {
  const set = new Set<string>(dirsOf(s).keys())
  for (const path of metasOf(s).keys()) {
    for (let p = parentOf(path); p; p = parentOf(p)) set.add(p)
  }
  return [...set].sort()
}

/** The content of every text file we have. */
export function snapshotFiles(s: ProjectStore): Record<string, string> {
  const out: Record<string, string> = {}
  for (const path of metasOf(s).keys()) {
    const text = textOf(s, path)
    if (text) out[path] = text.toString()
  }
  return out
}

/**
 * What a run of `entry` gets on its disk: texts and binary files (fetched
 * from the session if missing), only those `runVisible` allows.
 */
export async function projectFiles(s: ProjectStore, provider: { fetchBlob: (hash: string) => Promise<Uint8Array> } | null | undefined, entry: string) {
  const rules = rulesOf(s)
  const files: Record<string, string | Uint8Array> = {}
  for (const [path, text] of Object.entries(snapshotFiles(s))) if (runVisible(entry, path, rules)) files[path] = text
  for (const [path, meta] of Object.entries(rules.files)) {
    if (meta.kind !== "binary" || !meta.hash || !runVisible(entry, path, rules)) continue
    const bytes = await ensureBlob(meta.hash, provider ? (h) => provider.fetchBlob(h) : undefined).catch(() => null)
    if (bytes) files[path] = bytes
  }
  return files
}

/** Replaces the whole project content (files, folders, packages) and clears the console. */
export function replaceProject(s: ProjectStore, files: Record<string, string>, dirs: string[] = [], packages: PackageEntry[] = []) {
  const fresh: [string, string][] = []
  s.structure.transact(() => {
    const metas = metasOf(s)
    const d = dirsOf(s)
    for (const k of [...metas.keys()]) metas.delete(k)
    for (const k of [...d.keys()]) d.delete(k)
    for (const [path, content] of Object.entries(files)) {
      const id = newId()
      metas.set(path, { id, kind: "text", size: content.length })
      fresh.push([id, content])
    }
    for (const dir of dirs) d.set(dir, true)
    const pkgs = packagesOf(s)
    pkgs.delete(0, pkgs.length)
    pkgs.push(packages)
  })
  for (const [id, content] of fresh) if (content) s.doc(`f:${id}`).getText("t").insert(0, content)
  s.runtime.transact(() => {
    const term = s.runtime.getText("terminal")
    term.delete(0, term.length)
    s.runtime.getMap("run").clear()
  })
}

export function resetProject(s: ProjectStore) {
  replaceProject(s, { [DEFAULT_FILE]: DEFAULT_CODE })
}

/** The project's access rules, as written to .pycode.env. */
export function envOf(s: ProjectStore): EnvRules {
  const metas = metasOf(s).toJSON() as Record<string, FileMeta>
  return {
    roles: rolesOf(s).toJSON() as Record<string, "read" | "write">,
    folders: foldersOf(s).toJSON() as Record<string, string>,
    protected: Object.keys(metas).filter((p) => metas[p].protected),
    hidden: Object.keys(metas).filter((p) => metas[p].hidden),
  }
}

/** Replaces the project's access rules (after opening an archive). */
export function applyEnv(s: ProjectStore, env: EnvRules) {
  s.structure.transact(() => {
    const roles = rolesOf(s)
    const folders = foldersOf(s)
    roles.clear()
    folders.clear()
    for (const [name, level] of Object.entries(env.roles)) roles.set(name, level)
    for (const [path, role] of Object.entries(env.folders)) folders.set(path, role)
    for (const path of metasOf(s).keys()) {
      setFlag(s, path, "protected", env.protected.includes(path))
      setFlag(s, path, "hidden", env.hidden.includes(path))
    }
  })
}

// ---- adding files (drag and drop, archives) ------------------------------------

/** A whole project (text, binary files and board pictures) stays under this. */
export const PROJECT_LIMIT = 64 * 1024 * 1024

const TEXT_EXT = new Set(["py", "pyw", "md", "markdown", "txt", "json", "yaml", "yml", "toml", "csv", "html", "htm", "css", "js", "mjs", "xml", "svg", "ini", "cfg"])

/** Text if it has a known text extension, or is valid UTF-8 without NUL bytes. */
export function isText(path: string, bytes: Uint8Array): boolean {
  const ext = path.toLowerCase().split(".").pop() ?? ""
  if (TEXT_EXT.has(ext)) return true
  if (MIME[ext]) return false
  if (bytes.includes(0)) return false
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** Bytes the project takes: texts plus each distinct binary file once (and the board's pictures). */
export function projectSize(s: ProjectStore): number {
  let size = 0
  const hashes = new Set<string>()
  metasOf(s).forEach((meta, path) => {
    if (meta.kind === "text") size += textOf(s, path)?.length ?? meta.size
    else if (meta.hash && !hashes.has(meta.hash)) {
      hashes.add(meta.hash)
      size += meta.size
    }
  })
  s.board.getMap<{ dataURL?: string }>("files").forEach((f) => (size += f.dataURL?.length ?? 0))
  return size
}

/** A free path: "a.py", then "a (2).py", "a (3).py", … */
function freePath(s: ProjectStore, path: string): string {
  if (!exists(s, path)) return path
  const dot = path.lastIndexOf(".")
  const slash = path.lastIndexOf("/")
  const [base, ext] = dot > slash + 1 ? [path.slice(0, dot), path.slice(dot)] : [path, ""]
  for (let n = 2; ; n++) if (!exists(s, `${base} (${n})${ext}`)) return `${base} (${n})${ext}`
}

/**
 * Adds files under a folder: text files as text, the rest as binary
 * (bytes in the blob store). Nothing is added if the project would grow
 * past PROJECT_LIMIT.
 */
export async function addFiles(
  s: ProjectStore,
  dir: string,
  entries: { path: string; bytes: Uint8Array }[],
  env?: EnvRules | null,
): Promise<{ added: string[] } | { error: "limit" }> {
  // An archive's flags are part of each file from the start (see openArchive).
  const flags = (path: string): Pick<FileMeta, "protected" | "hidden"> | undefined =>
    env ? { ...(env.protected.includes(path) ? { protected: true } : {}), ...(env.hidden.includes(path) ? { hidden: true } : {}) } : undefined
  const known = new Set<string>()
  metasOf(s).forEach((m) => m.hash && known.add(m.hash))
  const prepared: { path: string; text?: string; meta?: FileMeta; bytes?: Uint8Array }[] = []
  let grow = 0
  for (const { path, bytes } of entries) {
    const full = cleanPath(dir ? `${dir}/${path}` : path)
    if (!full || full === RESERVED) continue
    if (isText(full, bytes)) {
      const text = new TextDecoder().decode(bytes)
      grow += text.length
      prepared.push({ path: full, text })
    } else {
      const hash = await sha256(bytes)
      if (!known.has(hash)) {
        known.add(hash)
        grow += bytes.length
      }
      prepared.push({ path: full, bytes, meta: { id: newId(), kind: "binary", size: bytes.length, hash, mime: mimeOf(full), ...flags(full) } })
    }
  }
  if (projectSize(s) + grow > PROJECT_LIMIT) return { error: "limit" }
  for (const p of prepared) if (p.bytes) await putBlob(p.bytes, p.meta!.hash)
  const added: string[] = []
  for (const p of prepared) {
    const path = freePath(s, p.path)
    if (p.meta) metasOf(s).set(path, p.meta)
    else createFile(s, path, p.text, flags(p.path))
    added.push(path)
  }
  return { added }
}

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  pdf: "application/pdf",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
}

export type DocKind = "pdf" | "pptx"

/** Documents with their own viewer (and presentation mode). */
export function docKindOf(path: string): DocKind | null {
  const ext = path.toLowerCase().split(".").pop()
  return ext === "pdf" ? "pdf" : ext === "pptx" ? "pptx" : null
}

export function mimeOf(path: string) {
  return MIME[path.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream"
}

// ---- archive --------------------------------------------------------------

/** Packs the project; binary files are fetched first if this browser lacks them. */
export async function exportZip(s: ProjectStore, fetch?: (hash: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  const entries: Record<string, Uint8Array> = {}
  for (const [path, content] of Object.entries(snapshotFiles(s))) entries[path] = strToU8(content)
  for (const [path, meta] of Object.entries(metasOf(s).toJSON() as Record<string, FileMeta>)) {
    if (meta.kind === "binary" && meta.hash) entries[path] = await ensureBlob(meta.hash, fetch).catch(() => new Uint8Array())
  }
  const env = envOf(s)
  if (Object.keys(env.roles).length || Object.keys(env.folders).length || env.protected.length || env.hidden.length) {
    entries[RESERVED] = strToU8(serializeEnv(env))
  }
  // Keep empty folders.
  for (const dir of dirsOf(s).keys()) {
    if (![...metasOf(s).keys()].some((p) => p.startsWith(dir + "/"))) entries[dir + "/"] = new Uint8Array()
  }
  return zipSync(entries, { level: 6 })
}

export interface Archive {
  entries: { path: string; bytes: Uint8Array }[]
  dirs: string[]
  env: EnvRules | null
  size: number
}

/** Reads a .zip: its files (text or binary, decided when added), folders and access rules. */
export function importZip(data: Uint8Array): Archive {
  const raw = unzipSync(data)
  const entries: Archive["entries"] = []
  const dirs: string[] = []
  let env: EnvRules | null = null
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
    if (path === RESERVED) env = parseEnv(strFromU8(raw[original]))
    else entries.push({ path, bytes: raw[original] })
  }
  return { entries, dirs, env, size: entries.reduce((n, e) => n + e.bytes.length, 0) }
}

/**
 * Replaces the project with an archive's content (keeps the packages). Too
 * big: nothing changes. The access rules come first, so in a session no
 * file is ever sent to someone the archive's rules keep it from.
 */
export async function openArchive(s: ProjectStore, zip: Archive): Promise<{ added: string[] } | { error: "limit" }> {
  let board = 0
  s.board.getMap<{ dataURL?: string }>("files").forEach((f) => (board += f.dataURL?.length ?? 0))
  if (zip.size + board > PROJECT_LIMIT) return { error: "limit" }
  replaceProject(s, {}, zip.dirs, packagesOf(s).toArray())
  if (zip.env) applyEnv(s, zip.env)
  return addFiles(s, "", zip.entries, zip.env)
}

// ---- the local project -------------------------------------------------------

const LEGACY_DB = "python-coder:project"
const LEGACY_PACKAGES = "python-coder:packages"

let local: ProjectStore | null = null

/** The user's own project, saved in IndexedDB (await `.ready`). */
export function localStore(): ProjectStore {
  if (local) return local
  const s = new ProjectStore(true)
  local = s
  const ready = s.ready.then(async () => {
    if (metasOf(s).size === 0) await migrate(s)
    // A run cannot survive a reload.
    const run = s.runtime.getMap("run")
    if (run.get("status") && run.get("status") !== "finished" && run.get("status") !== "idle") run.set("status", "idle")
  })
  s.ready = ready
  return s
}

/** First start of this version: bring over the single-document project of older ones. */
async function migrate(s: ProjectStore) {
  const old = new YDoc()
  const persistence = new IndexeddbPersistence(LEGACY_DB, old)
  await persistence.whenSynced
  const files = old.getMap<Y.Text>("files")
  if (files.size > 0) {
    const content: Record<string, string> = {}
    files.forEach((text, path) => (content[path] = text.toString()))
    replaceProject(s, content, [...old.getMap("dirs").keys()], old.getArray<PackageEntry>("packages").toArray())
  } else {
    let legacyCode: string | null = null
    let legacyPackages: PackageEntry[] = []
    try {
      legacyCode = localStorage.getItem("python-coder:code")
      legacyPackages = JSON.parse(localStorage.getItem(LEGACY_PACKAGES) ?? "[]")
    } catch {
      // storage unavailable
    }
    replaceProject(s, { [DEFAULT_FILE]: legacyCode ?? DEFAULT_CODE }, [], legacyPackages)
  }
  await persistence.clearData()
  old.destroy()
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
 * Renames a file or a folder (with everything inside). Only the metadata
 * moves: each file keeps its document, so open editors stay bound.
 * Returns how a path maps after the rename (for the open file).
 */
export function renamePath(s: ProjectStore, from: string, to: string): (path: string) => string {
  const map = (path: string) => (path === from ? to : path.startsWith(from + "/") ? to + path.slice(from.length) : path)
  s.structure.transact(() => {
    const metas = metasOf(s)
    const dirs = dirsOf(s)
    for (const key of [...metas.keys()]) {
      const next = map(key)
      if (next === key) continue
      const meta = metas.get(key)!
      metas.delete(key)
      metas.set(next, meta)
    }
    for (const key of [...dirs.keys()]) {
      const next = map(key)
      if (next === key) continue
      dirs.delete(key)
      dirs.set(next, true)
    }
    // Folder roles move with their folders.
    const folders = foldersOf(s)
    const moved = renameRules(folders.toJSON() as Record<string, string>, from, to)
    for (const key of [...folders.keys()]) if (!(key in moved)) folders.delete(key)
    for (const [key, role] of Object.entries(moved)) if (folders.get(key) !== role) folders.set(key, role)
  })
  return map
}
