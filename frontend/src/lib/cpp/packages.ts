import type { ProjectStore } from "@/lib/project/store"

import type { CppPackageFiles } from "./client"

export type CppPackageStatus = "installing" | "installed" | "error"

/** A header-only library from GitHub, served by jsDelivr. */
export interface CppPackage {
  /** What the user typed: `owner/repo` or `owner/repo@ref`. */
  spec: string
  repo: string
  ref: string | null
  /** Resolved by the first successful install; pinned from then on. */
  version?: string
  /** The folder `-I` points at (relative to the repository root, "" = the root). */
  include?: string
  status: CppPackageStatus
  error?: string
  /** Set only by `applyLoadFailures` (installed in the project, but did not load here); never written to the doc. */
  loadFailed?: boolean
}

export const cppPackagesOf = (s: ProjectStore) => s.structure.getArray<CppPackage>("cppPackages")

const SPEC = /^([\w.-]+\/[\w.-]+)(?:@([\w./+-]+))?$/

export function parseCppSpec(input: string): { repo: string; ref: string | null; spec: string } | null {
  const m = SPEC.exec(input.trim())
  if (!m || m[1].split("/").some((part) => /^\.+$/.test(part))) return null
  const ref = m[2] ?? null
  if (ref?.split("/").some((part) => part === "." || part === "..")) return null
  return { repo: m[1], ref, spec: ref ? `${m[1]}@${ref}` : m[1] }
}

/** Shows installed packages that did not load here (`failed`, keyed `repo@version`) as errors; the stored list is not changed. */
export function applyLoadFailures(stored: CppPackage[], failed: Record<string, string>): CppPackage[] {
  return stored.map((p) => {
    const error = p.status === "installed" ? failed[`${p.repo}@${p.version}`] : undefined
    return error === undefined ? p : { ...p, status: "error", error, loadFailed: true }
  })
}

/** The include folder: `include`, else `single_include`, else the root. */
export function pickInclude(paths: string[]): string {
  for (const dir of ["include", "single_include"]) if (paths.some((p) => p.startsWith(`${dir}/`))) return dir
  return ""
}

const HEADER_EXTENSIONS = ["h", "hpp", "hh", "hxx", "ipp", "inl", "tpp"]

/** Headers inside the include folder, plus files with no extension (Eigen's `Dense`). */
export function headerFiles(paths: string[], include: string): string[] {
  return paths.filter((p) => {
    if (include && !p.startsWith(`${include}/`)) return false
    const name = p.slice(p.lastIndexOf("/") + 1)
    const dot = name.lastIndexOf(".")
    return dot < 0 || HEADER_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase())
  })
}

const MAX_FILES = 2000
const MAX_BYTES = 32 * 1024 * 1024
const PARALLEL = 8

const API = "https://data.jsdelivr.com/v1/packages/gh"
const CDN = "https://cdn.jsdelivr.net/gh"

async function get(url: string, what: string) {
  const response = await fetch(url).catch(() => {
    throw new Error("Network error: jsDelivr is unreachable")
  })
  if (response.status === 404) throw new Error(`${what} not found`)
  if (!response.ok) throw new Error(`${what}: HTTP ${response.status}`)
  return response
}

export interface FetchedPackage {
  version: string
  include: string
  files: Record<string, string>
}

/** Resolves the version (unless given), lists the repository and downloads its headers. */
export async function fetchCppPackage(repo: string, version: string | null): Promise<FetchedPackage> {
  if (!version) version = ((await (await get(`${API}/${repo}/resolved`, "Repository")).json()) as { version?: string }).version ?? ""
  if (!version) throw new Error("Repository has no versions: add one as owner/repo@tag")
  const list = (await (await get(`${API}/${repo}@${version}?structure=flat`, "Version")).json()) as { files: { name: string; size: number }[] }
  const sizes = new Map(list.files.map((f) => [f.name.replace(/^\//, ""), f.size]))
  const paths = [...sizes.keys()]
  const include = pickInclude(paths)
  const headers = headerFiles(paths, include)
  if (!headers.length) throw new Error("The repository has no headers (.h, .hpp…)")
  if (headers.length > MAX_FILES || headers.reduce((n, p) => n + (sizes.get(p) ?? 0), 0) > MAX_BYTES) {
    throw new Error("The repository is too large (over 2000 headers or 32 MB)")
  }

  const files: Record<string, string> = {}
  let next = 0
  const worker = async () => {
    while (next < headers.length) {
      const path = headers[next++]
      const url = `${CDN}/${repo}@${version}/${path.split("/").map(encodeURIComponent).join("/")}`
      files[path] = await (await get(url, path)).text()
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, headers.length) }, worker))
  return { version, include, files }
}

// Downloaded packages by `repo@version`, kept for the page's lifetime.
const cache = new Map<string, Promise<FetchedPackage>>()

/** Downloads a package and remembers it, so the next lint does not fetch it again. */
export async function installCppPackage(repo: string, version: string | null): Promise<FetchedPackage> {
  const fetched = await fetchCppPackage(repo, version)
  cache.set(`${repo}@${fetched.version}`, Promise.resolve(fetched))
  return fetched
}

/** The headers of every installed package, ready for clang (`/packages/<repo>/…`); one that fails to load is left out and reported. */
export async function loadCppPackages(list: CppPackage[], onFail?: (repo: string, version: string, message: string) => void): Promise<CppPackageFiles> {
  const result: CppPackageFiles = { files: {}, includes: [] }
  const wanted = list.filter((p) => p.status === "installed" && p.version)
  const loaded = await Promise.allSettled(
    wanted.map(async (p) => {
      const key = `${p.repo}@${p.version}`
      let pending = cache.get(key)
      if (!pending) cache.set(key, (pending = fetchCppPackage(p.repo, p.version!)))
      try {
        return { repo: p.repo, ...(await pending) }
      } catch (error) {
        // Reported at once, and only while this load is still the current one: a Retry or a new install may have replaced it.
        if (cache.get(key) === pending) {
          cache.delete(key)
          onFail?.(p.repo, p.version!, error instanceof Error ? error.message : String(error))
        }
        throw error
      }
    }),
  )
  loaded.forEach((entry) => {
    if (entry.status === "rejected") return
    const { repo, include, files } = entry.value
    for (const [path, text] of Object.entries(files)) result.files[`/packages/${repo}/${path}`] = text
    result.includes.push(include ? `/packages/${repo}/${include}` : `/packages/${repo}`)
  })
  return result
}
