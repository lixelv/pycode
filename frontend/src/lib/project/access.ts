import type { FileMeta } from "./store"

/*
 * Who may read and change what. Every member checks this for what others
 * send (the server only says who has which role), so it is pure and the
 * same everywhere.
 */

export type Level = "read" | "write" | "admin"
export type Access = "none" | "read" | "write"

/** A member of a session: role is owner | admin | write | read | <custom role>. */
export interface Member {
  role: string
  level: Level
}

/** What the rules are read from: the project's structure document. */
export interface Rules {
  files: Record<string, FileMeta>
  /** Folder path -> role name: only that role (and admins) may see inside. */
  folders: Record<string, string>
  frozen: boolean
}

export const RESERVED = ".pycode.env"
export const isTest = (path: string) => path.endsWith(".test.py")

export function fileAccess(m: Member, path: string, r: Rules): Access {
  if (m.level === "admin") return "write"
  const meta = r.files[path]
  if (meta?.hidden) return "none"
  let result: Access = m.level === "write" ? "write" : "read"
  // Every role folder on the way must be the member's own.
  for (const [folder, role] of Object.entries(r.folders)) {
    if (!path.startsWith(folder + "/")) continue
    if (role !== m.role) return "none"
    result = "write"
  }
  return r.frozen || meta?.protected ? "read" : result
}

export function docAccess(m: Member, docId: string, r: Rules): Access {
  if (m.level === "admin") return "write"
  if (docId === "structure") return "read"
  if (docId === "runtime" || docId === "board") return m.level === "write" && !r.frozen ? "write" : "read"
  if (docId.startsWith("f:")) {
    const id = docId.slice(2)
    const path = Object.keys(r.files).find((p) => r.files[p].id === id)
    return path === undefined ? "none" : fileAccess(m, path, r)
  }
  return "none"
}

/** Folder roles follow a renamed folder. */
export function renameRules(folders: Record<string, string>, from: string, to: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [path, role] of Object.entries(folders)) {
    const next = path === from ? to : path.startsWith(from + "/") ? to + path.slice(from.length) : path
    out[next] = role
  }
  return out
}

// ---- .pycode.env: the access rules of an archive --------------------------------

export interface EnvRules {
  roles: Record<string, "read" | "write">
  folders: Record<string, string>
  protected: string[]
  hidden: string[]
}

export function serializeEnv(e: EnvRules): string {
  const lines = ["# pycode access rules"]
  for (const [name, level] of Object.entries(e.roles)) lines.push(`role ${name} ${level}`)
  for (const [path, role] of Object.entries(e.folders)) lines.push(`folder ${role} ${path}`)
  for (const path of e.protected) lines.push(`protected ${path}`)
  for (const path of e.hidden) lines.push(`hidden ${path}`)
  return lines.join("\n") + "\n"
}

export function parseEnv(text: string): EnvRules {
  const e: EnvRules = { roles: {}, folders: {}, protected: [], hidden: [] }
  for (const line of text.split("\n")) {
    const m = /^(role|folder|protected|hidden) (.+)$/.exec(line.trim())
    if (!m) continue
    const rest = m[2]
    if (m[1] === "role") {
      const [name, level] = rest.split(" ")
      if (level === "read" || level === "write") e.roles[name] = level
    } else if (m[1] === "folder") {
      const space = rest.indexOf(" ")
      if (space > 0) e.folders[rest.slice(space + 1)] = rest.slice(0, space)
    } else e[m[1] as "protected" | "hidden"].push(rest)
  }
  return e
}
