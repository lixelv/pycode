import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"

import type { CollabProvider } from "@/lib/collab/provider"
import { createDir, createFile, foldersOf, metasOf, setFolderRole, snapshotFiles, textOf } from "@/lib/project/project"
import { ProjectStore } from "@/lib/project/store"

import { routeArrows } from "./board"
import { replaceText, runTool, TOOLS, type AgentApp, type AgentContext } from "./tools"

// The app's browser-only modules; these tests need neither a session nor a runner.
vi.mock("@/lib/collab/provider", () => ({ addRole: vi.fn(), listCodes: vi.fn() }))
vi.mock("@/hooks/use-packages", () => ({ parseSpec: vi.fn() }))

function context(): AgentContext {
  const store = new ProjectStore(false)
  return { store, provider: { isOwner: true } as CollabProvider, app: { moved: vi.fn(), open: vi.fn(), active: () => "main.py" } as unknown as AgentApp }
}
const text = async (name: string, args: object, ctx: AgentContext) => {
  const result = await runTool(name, args, ctx)
  return { error: !!result.isError, text: result.content[0].type === "text" ? result.content[0].text : "" }
}

describe("the list of tools", () => {
  it("is the same on the server and here", () => {
    const listed = JSON.parse(readFileSync(resolve(__dirname, "../../../../backend/internal/session/mcp_tools.json"), "utf8")) as { name: string }[]
    expect(listed.map((t) => t.name).sort()).toEqual(Object.keys(TOOLS).sort())
  })
})

describe("files", () => {
  it("writes, creating the file, and edits an exact piece", async () => {
    const ctx = context()
    expect((await text("write_file", { path: "a/x.py", content: "print(1)\nprint(1)\n" }, ctx)).error).toBe(false)
    expect((await text("edit_file", { path: "a/x.py", old: "print(1)", new: "print(2)" }, ctx)).text).toContain("2 times")
    expect((await text("edit_file", { path: "a/x.py", old: "print(1)\nprint(1)", new: "$&" }, ctx)).error).toBe(false)
    expect(snapshotFiles(ctx.store)["a/x.py"]).toBe("$&\n")
    expect((await text("edit_file", { path: "a/x.py", old: "$&", new: "y", all: true }, ctx)).error).toBe(false)
  })

  it("refuses reserved names, bad paths and taken ones", async () => {
    const ctx = context()
    createFile(ctx.store, "a.py")
    expect((await text("write_file", { path: ".polycode.env", content: "" }, ctx)).error).toBe(true)
    expect((await text("create_file", { path: "../x", content: "" }, ctx)).error).toBe(true)
    expect((await text("create_file", { path: "a.py" }, ctx)).text).toContain("exists")
    expect((await text("read_file", { path: "nope.py" }, ctx)).error).toBe(true)
    expect((await text("no_such_tool", {}, ctx)).text).toContain("unknown tool")
    expect((await text("constructor", {}, ctx)).text).toContain("unknown tool")
  })

  it("keeps tests hidden by default, and flags as asked", async () => {
    const ctx = context()
    await text("create_file", { path: "t.test.py" }, ctx)
    expect(metasOf(ctx.store).get("t.test.py")!.hidden).toBe(true)
    await text("create_file", { path: "s.test.py", hidden: false, protected: true }, ctx)
    expect(metasOf(ctx.store).get("s.test.py")).toMatchObject({ protected: true })
    expect(metasOf(ctx.store).get("s.test.py")!.hidden).toBeUndefined()
  })

  it("moves and copies folders with their access, and tells the app", async () => {
    const ctx = context()
    createFile(ctx.store, "a/x.py", "1")
    setFolderRole(ctx.store, "a", "ivan")
    expect((await text("move_path", { from: "a", to: "a/b" }, ctx)).error).toBe(true)
    expect((await text("move_path", { from: "a", to: "b" }, ctx)).error).toBe(false)
    expect(ctx.app.moved).toHaveBeenCalled()
    expect(foldersOf(ctx.store).get("b")).toBe("ivan")
    await text("duplicate_path", { path: "b", to: "c" }, ctx)
    expect(foldersOf(ctx.store).get("c")).toBe("ivan")
    expect(snapshotFiles(ctx.store)["c/x.py"]).toBe("1")
  })

  it("gives folder access only to what exists", async () => {
    const ctx = context()
    createDir(ctx.store, "d")
    expect((await text("set_folder_access", { path: "d", access: "ghost" }, ctx)).error).toBe(true)
    await text("set_folder_access", { path: "d", access: "admins" }, ctx)
    expect(foldersOf(ctx.store).get("d")).toBe("@admins")
    await text("set_folder_access", { path: "d", access: "public" }, ctx)
    expect(foldersOf(ctx.store).has("d")).toBe(false)
  })

  it("reads line ranges and finds lines", async () => {
    const ctx = context()
    createFile(ctx.store, "a.py", "one\ntwo\nthree")
    expect((await text("read_file", { path: "a.py", start_line: 2, end_line: 2 }, ctx)).text).toBe("two")
    expect(JSON.parse((await text("search_files", { query: "^t", regex: true }, ctx)).text).matches.map((m: { line: number }) => m.line)).toEqual([2, 3])
    expect((await text("search_files", { query: "(", regex: true }, ctx)).error).toBe(true)
  })
})

describe("routeArrows", () => {
  const boxes = [
    { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 100 },
    { id: "b", type: "rectangle", x: 0, y: 300, width: 100, height: 100 },
  ]
  it("draws an arrow from edge to edge, keeping a straight one's zero as a tiny size", () => {
    const [, , arrow] = routeArrows([...boxes, { type: "arrow", x: 0, y: 0, width: 0, height: 0, start: { id: "a" }, end: { id: "b" } }], () => undefined)
    expect(arrow).toMatchObject({ x: 50, y: 108, width: 0.01, height: 184 })
  })
  it("finds elements of earlier calls and goes backwards too", () => {
    const [arrow] = routeArrows([{ type: "arrow", start: { id: "b" }, end: { id: "a" } }], (id) => boxes.find((b) => b.id === id))
    expect(arrow).toMatchObject({ x: 50, y: 292, height: -184 })
  })
  it("leaves an arrow with a free end alone", () => {
    const free = { type: "arrow", x: 1, y: 2, width: 3, height: 4, start: { id: "a" } }
    expect(routeArrows([boxes[0], free], () => undefined)[1]).toEqual(free)
  })
})

describe("replaceText", () => {
  it("changes only what differs", () => {
    const s = new ProjectStore(false)
    createFile(s, "a.py", "abcXdef")
    const y = textOf(s, "a.py")!
    const deleted = vi.spyOn(y, "delete")
    replaceText(y, "abcYYdef")
    expect(y.toString()).toBe("abcYYdef")
    expect(deleted).toHaveBeenCalledWith(3, 1)
    replaceText(y, "")
    expect(y.toString()).toBe("")
    replaceText(y, "aa")
    replaceText(y, "aaa")
    expect(y.toString()).toBe("aaa")
  })
})
