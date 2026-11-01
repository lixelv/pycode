import { parseCppSpec, cppPackagesOf, type CppPackage } from "@/lib/cpp/packages"
import { readRun, readTerminal, sharedRun, sharedTerminal } from "@/lib/collab/doc"
import { addRole, listCodes, type CollabProvider, type PeerUser } from "@/lib/collab/provider"
import type { PackageEntry } from "@/hooks/use-packages"
import { parseSpec } from "@/hooks/use-packages"
import { ADMINS_ONLY, isReserved, type Level } from "@/lib/project/access"
import { ensureBlob } from "@/lib/project/blobs"
import {
  addFiles,
  allDirs,
  cleanPath,
  createDir,
  createFile,
  deletePath,
  docKindOf,
  duplicatePath,
  exists,
  exportZip,
  foldersOf,
  importZip,
  languageOf,
  languagesOf,
  metasOf,
  mimeOf,
  openArchive,
  packagesOf,
  parentOf,
  PROJECT_LIMIT,
  renamePath,
  resetProject,
  rolesOf,
  setFlag,
  setFolderRole,
  snapshotFiles,
  startProject,
  stateOf,
  textOf,
  tournamentsOf,
  type ProjectLanguage,
} from "@/lib/project/project"
import type { ProjectStore } from "@/lib/project/store"
import { resultsOf, standings, type TournamentEntry } from "@/lib/tournament"
import type { CheckResult } from "@/workers/protocol"

import { boardAdd, boardAlign, boardClear, boardDelete, boardDistribute, boardDuplicate, boardExport, boardGroup, boardImage, boardImport, boardLock, boardMermaid, boardRead, boardRestore, boardSnapshot, boardUngroup, boardUpdate, type Alignment } from "./board"

/*
 * What an agent can do through MCP (backend/internal/session/mcp_tools.json has
 * the descriptions; a test keeps the two equal). Each tool runs here, in the
 * acting owner's browser, on the same project and the same runners as the
 * person at it.
 */

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } }
export interface ToolResult {
  content: Content[]
  isError?: boolean
}

/** What only the running app can do: its screen, its runners, its packages. */
export interface AgentApp {
  open(path: string): void
  /** Makes `path` the open file and starts it; resolves once the run is under way. */
  run(path: string, debug: boolean, breakpoints?: Record<string, number[]>): Promise<void>
  sendInput(text: string): void
  sendEof(): void
  stop(): void
  debugCommand(command: "continue" | "next" | "step" | "return" | "stop"): void
  check(path: string): Promise<{ results: CheckResult[] | null; error?: string; tournament?: unknown; testFile?: string }>
  moved(map: (path: string) => string): void
  installPython(spec: string): Promise<void>
  removePython(name: string): void
  installCpp(spec: string): Promise<void>
  removeCpp(repo: string): void
  diagnostics(path: string): Promise<unknown[]>
  format(path: string, code: string): Promise<string>
  analyse(path: string, code: string, mode: "flow" | "ast", lang: string): Promise<unknown>
  active(): string
}

export interface AgentContext {
  store: ProjectStore
  provider: CollabProvider
  app: AgentApp
}

type Args = Record<string, unknown>
type Tool = (args: Args, ctx: AgentContext) => Promise<ToolResult | string | object | void> | ToolResult | string | object | void

const MAX_TAIL = 200_000
const MAX_WAIT = 120
const MAX_MATCHES = 200
/** The answer has to fit a WebSocket frame (maxFrame in the backend). */
export const MAX_ANSWER = (4 << 20) - (64 << 10)

class ToolError extends Error {}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function string(args: Args, key: string): string {
  const value = args[key]
  if (typeof value !== "string") throw new ToolError(`\`${key}\` must be a string`)
  return value
}
const optionalNumber = (args: Args, key: string, fallback: number) => (typeof args[key] === "number" ? (args[key] as number) : fallback)

/** A path as the project writes it. */
function pathOf(args: Args, key = "path"): string {
  const path = cleanPath(string(args, key))
  if (!path) throw new ToolError(`bad path: ${String(args[key])}`)
  return path
}
function newPath(args: Args, key: string, s: ProjectStore): string {
  const path = pathOf(args, key)
  if (isReserved(path)) throw new ToolError(`${path} is reserved`)
  if (exists(s, path)) throw new ToolError(`${path} already exists`)
  return path
}
function existing(args: Args, s: ProjectStore): string {
  const path = pathOf(args)
  if (!exists(s, path)) throw new ToolError(`no ${path} in the project`)
  return path
}
function textFile(args: Args, s: ProjectStore) {
  const path = existing(args, s)
  const text = textOf(s, path)
  if (!text) throw new ToolError(`${path} is not a text file`)
  return { path, text }
}

/** Changes only what differs, so cursors and others' edits elsewhere in the file survive. */
export function replaceText(text: { doc: { transact(fn: () => void): void } | null; toString(): string; delete(i: number, n: number): void; insert(i: number, s: string): void }, next: string) {
  const old = text.toString()
  let start = 0
  const shortest = Math.min(old.length, next.length)
  while (start < shortest && old[start] === next[start]) start++
  let end = 0
  while (end < shortest - start && old[old.length - 1 - end] === next[next.length - 1 - end]) end++
  const apply = () => {
    if (old.length - start - end) text.delete(start, old.length - start - end)
    if (next.length - start - end) text.insert(start, next.slice(start, next.length - end))
  }
  if (text.doc) text.doc.transact(apply)
  else apply()
}

function base64Of(bytes: Uint8Array): string {
  const step = 0x8000
  let binary = ""
  for (let i = 0; i < bytes.length; i += step) binary += String.fromCharCode(...bytes.subarray(i, i + step))
  return btoa(binary)
}
function bytesOf(base64: string): Uint8Array {
  try {
    return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  } catch {
    throw new ToolError("not valid base64")
  }
}

const IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"])

// ---- the console ----------------------------------------------------------------

function consoleState(s: ProjectStore, tail = 20_000) {
  const run = readRun(s.runtime)
  const shared = sharedRun(s.runtime)
  const text = readTerminal(s.runtime).map((chunk) => chunk.text).join("")
  const size = Math.min(MAX_TAIL, Math.max(0, tail))
  return {
    status: run.status,
    exit: run.exit,
    debugging: !!shared.get("debugging"),
    debug: shared.get("debug") ?? null,
    output: text.slice(-size),
    truncated: text.length > size,
  }
}

/** The console once the program has ended, asks for input or stopped in the debugger, or after the wait. */
async function settled(s: ProjectStore, args: Args, fallback: number) {
  const until = performance.now() + Math.min(MAX_WAIT, optionalNumber(args, "wait_seconds", fallback)) * 1000
  for (;;) {
    const { status } = readRun(s.runtime)
    if (status === "idle" || status === "finished" || status === "waiting" || sharedRun(s.runtime).get("debug")) break
    if (performance.now() >= until) break
    await sleep(50)
  }
  return consoleState(s, optionalNumber(args, "tail", 20_000))
}

// ---- members ---------------------------------------------------------------------

function members({ provider }: AgentContext) {
  const out: object[] = []
  provider.awareness.getStates().forEach((state, clientId) => {
    const member = provider.memberOf(clientId)
    if (!member) return
    const { user, file } = state as { user?: PeerUser; file?: string }
    out.push({ peer: member.peer, name: user?.name, userId: user?.id, level: member.level, roles: member.roles, owner: !!member.owner, standingInForOwner: member.acting && !member.owner, file, me: clientId === provider.clientID })
  })
  return out
}

/** Waits until `done` says the server did it; the server's refusal arrives as an error. */
function serverChange({ provider }: AgentContext, send: () => void, done: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const off = provider.on("error", (message) => {
      clearInterval(timer)
      off()
      reject(new ToolError(message))
    })
    const timer = setInterval(() => {
      if (!done() && performance.now() - started < 5000) return
      clearInterval(timer)
      off()
      if (done()) resolve()
      else reject(new ToolError("the server did not confirm the change"))
    }, 50)
    send()
  })
}

function requirePeer(ctx: AgentContext, args: Args): number {
  const peer = args.peer
  if (typeof peer !== "number" || !members(ctx).some((m) => (m as { peer: number }).peer === peer)) throw new ToolError(`no member with peer ${String(peer)}: see list_members`)
  if (peer === ctx.provider.memberOf(ctx.provider.clientID)?.peer) throw new ToolError("that is the browser you are working through")
  return peer
}

function ids(args: Args): string[] {
  if (!Array.isArray(args.ids) || !args.ids.length) throw new ToolError("`ids` must be a list of element ids")
  return args.ids as string[]
}

const hasPeer = (ctx: AgentContext, peer: number) => members(ctx).some((m) => (m as { peer: number }).peer === peer)

function kick(ctx: AgentContext, args: Args, ban: boolean) {
  const peer = requirePeer(ctx, args)
  return serverChange(ctx, () => ctx.provider.kick(peer, ban), () => !hasPeer(ctx, peer)).then(() => "done")
}

// ---- the tools -------------------------------------------------------------------

export const TOOLS: Record<string, Tool> = {
  project_overview(_args, ctx) {
    const { store: s, app } = ctx
    const metas = [...metasOf(s).entries()].map(([path, m]) => ({ path, kind: m.kind, size: m.kind === "text" ? (textOf(s, path)?.length ?? m.size) : m.size, ...(m.mime ? { mime: m.mime } : {}), ...(m.protected ? { protected: true } : {}), ...(m.hidden ? { hidden: true } : {}) }))
    const state = stateOf(s)
    const { output: _output, ...run } = consoleState(s, 0)
    return {
      openFile: app.active(),
      languages: languagesOf(s),
      frozen: !!state.get("frozen"),
      presentation: state.get("presentation") ?? null,
      files: metas.sort((a, b) => a.path.localeCompare(b.path)),
      folders: allDirs(s),
      folderAccess: foldersOf(s).toJSON(),
      roles: rolesOf(s).toJSON(),
      members: members(ctx),
      console: run,
      pythonPackages: packagesOf(s).toArray(),
      cppPackages: cppPackagesOf(s).toArray(),
      tournaments: tournamentsOf(s).toJSON(),
      boardElements: boardRead(s).length,
    }
  },

  async read_file(args, { store: s, provider }) {
    const path = existing(args, s)
    const meta = metasOf(s).get(path)
    if (!meta) throw new ToolError(`${path} is a folder`)
    const text = textOf(s, path)
    if (text) {
      const all = text.toString()
      if (typeof args.start_line !== "number" && typeof args.end_line !== "number") return all
      return all.split("\n").slice(optionalNumber(args, "start_line", 1) - 1, optionalNumber(args, "end_line", Number.MAX_SAFE_INTEGER)).join("\n")
    }
    if (!meta.hash) throw new ToolError(`${path} has no content`)
    const bytes = await ensureBlob(meta.hash, (hash) => provider.fetchBlob(hash))
    const mimeType = meta.mime ?? mimeOf(path)
    const data = base64Of(bytes)
    if (IMAGES.has(mimeType)) return { content: [{ type: "image", data, mimeType }] }
    return { content: [{ type: "resource", resource: { uri: `polycode:///${path}`, mimeType, blob: data } }] }
  },

  write_file(args, { store: s }) {
    const content = string(args, "content")
    const path = pathOf(args)
    if (isReserved(path)) throw new ToolError(`${path} is reserved`)
    if (!metasOf(s).has(path)) {
      if (exists(s, path)) throw new ToolError(`${path} is a folder`)
      createFile(s, path, content)
      return `created ${path}`
    }
    const text = textOf(s, path)
    if (!text) throw new ToolError(`${path} is not a text file`)
    replaceText(text, content)
    return `wrote ${path}`
  },

  edit_file(args, { store: s }) {
    const { path, text } = textFile(args, s)
    const old = string(args, "old")
    const next = string(args, "new")
    if (!old) throw new ToolError("`old` is empty")
    const all = text.toString()
    const count = all.split(old).length - 1
    if (!count) throw new ToolError(`\`old\` is not in ${path}`)
    if (count > 1 && !args.all) throw new ToolError(`\`old\` occurs ${count} times in ${path}: give more context, or set \`all\``)
    replaceText(text, args.all ? all.split(old).join(next) : all.replace(old, () => next))
    return `replaced ${count} in ${path}`
  },

  create_file(args, { store: s }) {
    const path = newPath(args, "path", s)
    const hasFlags = typeof args.hidden === "boolean" || typeof args.protected === "boolean"
    createFile(s, path, typeof args.content === "string" ? args.content : "", hasFlags ? { ...(args.hidden ? { hidden: true } : {}), ...(args.protected ? { protected: true } : {}) } : undefined)
    return `created ${path}`
  },

  async upload_file(args, { store: s }) {
    const path = pathOf(args)
    const result = await addFiles(s, parentOf(path), [{ path: path.slice(parentOf(path).length ? parentOf(path).length + 1 : 0), bytes: bytesOf(string(args, "base64")) }])
    if ("error" in result) throw new ToolError(`the project is limited to ${PROJECT_LIMIT >> 20} MB`)
    if (!result.added.length) throw new ToolError(`${path} cannot be added`)
    return { added: result.added }
  },

  create_folder(args, { store: s }) {
    const path = newPath(args, "path", s)
    createDir(s, path)
    return `created ${path}`
  },

  delete_path(args, { store: s }) {
    const path = existing(args, s)
    deletePath(s, path)
    return `deleted ${path}`
  },

  move_path(args, { store: s, app }) {
    const from = pathOf(args, "from")
    if (!exists(s, from)) throw new ToolError(`no ${from} in the project`)
    const to = newPath(args, "to", s)
    if (to.startsWith(from + "/")) throw new ToolError("a folder cannot go inside itself")
    app.moved(renamePath(s, from, to))
    return `moved to ${to}`
  },

  duplicate_path(args, { store: s, app }) {
    const path = existing(args, s)
    const target = typeof args.to === "string" ? newPath(args, "to", s) : null
    const result = duplicatePath(s, path)
    if ("error" in result) throw new ToolError(`the project is limited to ${PROJECT_LIMIT >> 20} MB`)
    if (!target) return { to: result.to }
    app.moved(renamePath(s, result.to, target))
    return { to: target }
  },

  search_files(args, { store: s }) {
    const query = string(args, "query")
    let test: (line: string) => boolean
    if (args.regex) {
      let regex: RegExp
      try {
        regex = new RegExp(query)
      } catch (err) {
        throw new ToolError((err as Error).message)
      }
      test = (line) => regex.test(line)
    } else test = (line) => line.includes(query)
    const folder = typeof args.folder === "string" ? args.folder.replace(/\/$/, "") + "/" : ""
    const matches: { path: string; line: number; text: string }[] = []
    for (const [path, content] of Object.entries(snapshotFiles(s))) {
      if (!path.startsWith(folder)) continue
      const lines = content.split("\n")
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) if (test(lines[i])) matches.push({ path, line: i + 1, text: lines[i].slice(0, 300) })
    }
    return { matches, truncated: matches.length === MAX_MATCHES }
  },

  set_file_flags(args, { store: s }) {
    const path = existing(args, s)
    if (!metasOf(s).has(path)) throw new ToolError(`${path} is a folder: use set_folder_access`)
    for (const flag of ["hidden", "protected"] as const) if (typeof args[flag] === "boolean") setFlag(s, path, flag, args[flag] as boolean)
    return metasOf(s).get(path)
  },

  set_folder_access(args, { store: s }) {
    const path = existing(args, s)
    if (metasOf(s).has(path)) throw new ToolError(`${path} is a file: use set_file_flags`)
    const access = string(args, "access")
    if (access !== "public" && access !== "admins" && !rolesOf(s).has(access)) throw new ToolError(`no role ${access}: use public, admins or one of ${Object.keys(rolesOf(s).toJSON()).join(", ") || "(no custom roles yet)"}`)
    setFolderRole(s, path, access === "public" ? null : access === "admins" ? ADMINS_ONLY : access)
    return `${path}: ${access}`
  },

  open_file(args, { store: s, app }) {
    const path = existing(args, s)
    if (!metasOf(s).has(path)) throw new ToolError(`${path} is a folder`)
    app.open(path)
    return `opened ${path}`
  },

  async get_diagnostics(args, { store: s, app }) {
    const { path } = textFile(args, s)
    return { diagnostics: await app.diagnostics(path) }
  },

  async format_file(args, { store: s, app }) {
    const { path, text } = textFile(args, s)
    const formatted = await app.format(path, text.toString())
    replaceText(text, formatted)
    return `formatted ${path}`
  },

  get_flowchart: (args, { store: s, app }) => {
    const { path, text } = textFile(args, s)
    return app.analyse(path, text.toString(), "flow", args.lang === "ru" ? "ru" : "en") as Promise<object>
  },

  get_syntax_tree: (args, { store: s, app }) => {
    const { path, text } = textFile(args, s)
    return app.analyse(path, text.toString(), "ast", "en") as Promise<object>
  },

  async run_program(args, { store: s, app }) {
    const path = existing(args, s)
    if (!metasOf(s).has(path)) throw new ToolError(`${path} is a folder`)
    const kind = languageOf(path)
    if (!textOf(s, path) || !(kind === "python" || kind === "cpp" || kind === "html" || kind === "javascript") || /\.(h|hpp)$/i.test(path)) throw new ToolError(`${path} is not a program`)
    if (args.debug && languageOf(path) !== "python") throw new ToolError("the debugger is for Python only")
    await app.run(path, !!args.debug, args.breakpoints as Record<string, number[]> | undefined)
    return settled(s, args, 30)
  },

  console_read: (args, { store: s }) => settled(s, args, 0),

  send_input(args, { store: s, app }) {
    const text = string(args, "text")
    if (readRun(s.runtime).status !== "waiting") throw new ToolError("the program is not asking for input")
    app.sendInput(text)
    return sleep(100).then(() => settled(s, args, 30))
  },

  send_eof(args, { store: s, app }) {
    if (readRun(s.runtime).status !== "waiting") throw new ToolError("the program is not asking for input")
    app.sendEof()
    return sleep(100).then(() => settled(s, args, 30))
  },

  stop_program(_args, { store: s, app }) {
    app.stop()
    return sleep(100).then(() => settled(s, {}, 5))
  },

  clear_console(_args, { store: s }) {
    const term = sharedTerminal(s.runtime)
    term.delete(0, term.length)
    return "cleared"
  },

  debug_command(args, { store: s, app }) {
    const command = string(args, "command") as "continue" | "next" | "step" | "return" | "stop"
    if (!["continue", "next", "step", "return", "stop"].includes(command)) throw new ToolError("unknown command")
    if (!sharedRun(s.runtime).get("debug")) throw new ToolError("the debugger is not stopped")
    app.debugCommand(command)
    return sleep(150).then(() => settled(s, args, 30))
  },

  async run_check(args, { store: s, app }) {
    const { path } = textFile(args, s)
    const done = await app.check(path)
    if (done.error) throw new ToolError(done.error)
    return done
  },

  list_members: (_args, ctx) => ({ members: members(ctx) }),

  set_member_role(args, ctx) {
    const peer = requirePeer(ctx, args)
    const level = string(args, "level") as Level
    const roles = Array.isArray(args.roles) ? (args.roles as string[]) : (members(ctx).find((m) => (m as { peer: number }).peer === peer) as { roles: string[] }).roles
    const same = () => {
      const member = members(ctx).find((m) => (m as { peer: number }).peer === peer) as { level: string; roles: string[] } | undefined
      return member?.level === level && [...member.roles].sort().join() === [...roles].sort().join()
    }
    return serverChange(ctx, () => ctx.provider.setRole(peer, level, roles), same).then(() => "done")
  },

  kick_member: (args, ctx) => kick(ctx, args, false),
  ban_member: (args, ctx) => kick(ctx, args, true),

  async share_links(_args, { provider }) {
    const { codes } = await listCodes(provider.code)
    const links = codes.map((c) => ({ role: c.role, level: c.level, code: c.code, link: `${location.origin}/s/${c.code}` }))
    const admin = codes.find((c) => c.role === "admin")
    return { links, mcp: admin && `${location.origin}/s/${admin.code}/mcp` }
  },

  async add_role(args, { store: s, provider }) {
    const name = string(args, "name")
    const level = string(args, "level") as "read" | "write"
    const code = await addRole(provider.code, name, level).catch((err: Error) => {
      throw new ToolError(err.message)
    })
    rolesOf(s).set(name, level)
    return { role: name, level, code: code.code, link: `${location.origin}/s/${code.code}` }
  },

  set_frozen(args, { store: s }) {
    stateOf(s).set("frozen", !!args.frozen)
    return args.frozen ? "frozen" : "thawed"
  },

  presentation_start(args, { store: s, app }) {
    const path = existing(args, s)
    if (!docKindOf(path)) throw new ToolError("only PDF and PPTX can be presented")
    app.open(path)
    stateOf(s).set("presentation", { path, page: optionalNumber(args, "page", 1), by: s.clientID })
    return "presenting"
  },

  presentation_page(args, { store: s }) {
    const current = stateOf(s).get("presentation") as object | undefined
    if (!current) throw new ToolError("nothing is being presented")
    stateOf(s).set("presentation", { ...current, page: optionalNumber(args, "page", 1), by: s.clientID })
    return "ok"
  },

  presentation_stop(_args, { store: s }) {
    stateOf(s).delete("presentation")
    return "stopped"
  },

  list_packages: (_args, { store: s }) => ({ python: packagesOf(s).toArray(), cpp: cppPackagesOf(s).toArray() }),

  async install_package(args, { store: s, app }) {
    const spec = string(args, "spec")
    if (args.language === "python") {
      const parsed = parseSpec(spec)
      if (!parsed) throw new ToolError(`bad package: ${spec}`)
      await app.installPython(spec)
      const entry = packagesOf(s).toArray().find((p: PackageEntry) => p.name === parsed.name)
      if (entry?.status === "error") throw new ToolError(entry.error ?? "installation failed")
      return entry
    }
    if (args.language !== "cpp") throw new ToolError("`language` must be python or cpp")
    const parsed = parseCppSpec(spec)
    if (!parsed) throw new ToolError(`bad library, expected owner/repo or owner/repo@version: ${spec}`)
    await app.installCpp(spec)
    const entry = cppPackagesOf(s).toArray().find((p: CppPackage) => p.repo === parsed.repo)
    if (entry?.status === "error") throw new ToolError(entry.error ?? "installation failed")
    return entry
  },

  remove_package(args, { app }) {
    const name = string(args, "name")
    if (args.language === "python") app.removePython(name)
    else if (args.language === "cpp") app.removeCpp(name)
    else throw new ToolError("`language` must be python or cpp")
    return `removed ${name}`
  },

  tournament_list: (_args, { store: s }) => tournamentsOf(s).toJSON(),

  tournament_standings(args, { store: s }) {
    const id = string(args, "id")
    if (!tournamentsOf(s).has(id)) throw new ToolError(`no tournament ${id}`)
    return { standings: standings(resultsOf(s.doc(`t:${id}`)).toJSON() as Record<string, TournamentEntry>) }
  },

  tournament_set_private(args, { store: s }) {
    const id = string(args, "id")
    if (!tournamentsOf(s).has(id)) throw new ToolError(`no tournament ${id}`)
    tournamentsOf(s).set(id, { private: !!args.private })
    return "ok"
  },

  board_read: (_args, { store: s }) => ({ elements: boardRead(s) }),

  async board_add(args, { store: s }) {
    if (!Array.isArray(args.elements)) throw new ToolError("`elements` must be an array")
    return { ids: await boardAdd(s, args.elements as Args[]) }
  },

  board_update(args, { store: s }) {
    if (!Array.isArray(args.elements)) throw new ToolError("`elements` must be an array")
    boardUpdate(s, args.elements as Args[])
    return "ok"
  },

  board_delete(args, { store: s }) {
    boardDelete(s, ids(args))
    return "ok"
  },

  board_clear(_args, { store: s }) {
    boardClear(s)
    return "cleared"
  },

  async board_mermaid(args, { store: s }) {
    return { ids: await boardMermaid(s, string(args, "definition"), optionalNumber(args, "x", 0), optionalNumber(args, "y", 0)) }
  },

  async board_image(args, { store: s }) {
    const blob = await boardImage(s, Array.isArray(args.ids) ? (args.ids as string[]) : undefined)
    if (!blob) return "the board is empty"
    return { content: [{ type: "image", data: base64Of(new Uint8Array(await blob.arrayBuffer())), mimeType: "image/png" }] }
  },

  board_duplicate: (args, { store: s }) => ({ ids: boardDuplicate(s, ids(args), optionalNumber(args, "dx", 20), optionalNumber(args, "dy", 20)) }),

  board_align(args, { store: s }) {
    boardAlign(s, ids(args), string(args, "alignment") as Alignment)
    return "ok"
  },

  board_distribute(args, { store: s }) {
    boardDistribute(s, ids(args), args.direction === "vertical" ? "vertical" : "horizontal")
    return "ok"
  },

  board_group: (args, { store: s }) => ({ group: boardGroup(s, ids(args)) }),

  board_ungroup(args, { store: s }) {
    boardUngroup(s, ids(args))
    return "ok"
  },

  board_lock(args, { store: s }) {
    boardLock(s, ids(args), args.locked !== false)
    return "ok"
  },

  board_export: (_args, { store: s }) => boardExport(s),

  board_import: (args, { store: s }) => ({ elements: boardImport(s, string(args, "scene"), !!args.replace) }),

  board_snapshot(args, { store: s }) {
    boardSnapshot(s, string(args, "name"))
    return "saved"
  },

  board_restore: (args, { store: s }) => ({ elements: boardRestore(s, string(args, "name")) }),

  async export_project(_args, { store: s, provider }) {
    const missing: string[] = []
    const zip = await exportZip(s, (hash) => provider.fetchBlob(hash), missing)
    return { content: [{ type: "resource", resource: { uri: "polycode:///project.zip", mimeType: "application/zip", blob: base64Of(zip) } }, ...(missing.length ? [{ type: "text" as const, text: `missing: ${missing.join(", ")}` }] : [])] }
  },

  async import_project(args, { store: s, app }) {
    let archive: ReturnType<typeof importZip>
    try {
      archive = importZip(bytesOf(string(args, "base64")))
    } catch (err) {
      throw new ToolError(err instanceof ToolError ? err.message : "not a valid .zip")
    }
    const opened = await openArchive(s, archive)
    if ("error" in opened) throw new ToolError(`the project is limited to ${PROJECT_LIMIT >> 20} MB`)
    const first = archive.entries.map((e) => e.path).sort()[0]
    if (first) app.open(first)
    return { files: archive.entries.length }
  },

  reset_project(args, { store: s, provider, app }) {
    if (!provider.isOwner) throw new ToolError("only the owner can reset the project")
    resetProject(s)
    provider.announceReset()
    if (args.language === "python" || args.language === "cpp") {
      startProject(s, args.language as ProjectLanguage)
      app.open(args.language === "python" ? "main.py" : "main.cpp")
    }
    return "reset"
  },
}

/** Runs a tool to an MCP answer; a failure is the agent's to read, not a crash. */
export async function runTool(name: string, args: unknown, ctx: AgentContext): Promise<ToolResult> {
  const fail = (text: string): ToolResult => ({ isError: true, content: [{ type: "text", text }] })
  const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined
  if (!tool) return fail(`unknown tool: ${name}`)
  let result: ToolResult
  try {
    const value = await tool((args ?? {}) as Args, ctx)
    if (typeof value === "string") result = { content: [{ type: "text", text: value }] }
    else if (value && Array.isArray((value as ToolResult).content)) result = value as ToolResult
    else result = { content: [{ type: "text", text: JSON.stringify(value ?? "ok", null, 1) }] }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
  return JSON.stringify(result).length > MAX_ANSWER ? fail(`the answer is too large (over ${MAX_ANSWER >> 20} MB): ask for less`) : result
}
