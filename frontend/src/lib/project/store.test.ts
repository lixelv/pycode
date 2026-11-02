import { describe, expect, it, vi } from "vitest"
import * as Y from "yjs"

import { runTool, type AgentApp, type AgentContext } from "@/lib/agent/tools"
import type { CollabProvider } from "@/lib/collab/provider"

import { createDir, createFile, deletePath, dirsOf, duplicatePath, exportZip, foldersOf, importZip, metasOf, moveTarget, openArchive, renamePath, replaceProject, resetProject, setFlag, setFolderRole, setUp, snapshotFiles, stateOf, textOf } from "./project"
import { ProjectStore } from "./store"

// The agent's tools import these browser-only modules.
vi.mock("@/lib/collab/provider", () => ({ addRole: vi.fn(), listCodes: vi.fn() }))
vi.mock("@/hooks/use-packages", () => ({ parseSpec: vi.fn() }))

describe("ProjectStore", () => {
  it("keeps each file's text in its own document", () => {
    const s = new ProjectStore(false)
    createFile(s, "main.py", "print(1)")
    const meta = metasOf(s).get("main.py")!
    expect(meta.kind).toBe("text")
    expect(s.ids()).toContain(`f:${meta.id}`)
    expect(textOf(s, "main.py")!.toString()).toBe("print(1)")
  })

  it("renames by moving the metadata, keeping the same text", () => {
    const s = new ProjectStore(false)
    createFile(s, "a/x.py", "x = 1")
    const before = textOf(s, "a/x.py")
    renamePath(s, "a", "b")
    expect(metasOf(s).has("a/x.py")).toBe(false)
    expect(textOf(s, "b/x.py")).toBe(before)
  })

  it("says where a move lands, or why it cannot", () => {
    const s = new ProjectStore(false)
    createFile(s, "a/x.py", "")
    createFile(s, "a/b/y.py", "")
    createFile(s, "c/x.py", "")
    createDir(s, "d")
    expect(moveTarget(s, "a/x.py", "d")).toEqual({ to: "d/x.py" })
    expect(moveTarget(s, "a/x.py", "")).toEqual({ to: "x.py" })
    expect(moveTarget(s, "a/b", "d")).toEqual({ to: "d/b" })
    expect(moveTarget(s, "a/x.py", "a")).toEqual({ error: "same" })
    expect(moveTarget(s, "a/x.py", "c")).toEqual({ error: "exists" })
    expect(moveTarget(s, "a", "a")).toEqual({ error: "inside" })
    expect(moveTarget(s, "a", "a/b")).toEqual({ error: "inside" })
    createFile(s, "d/.polycode.env", "")
    expect(moveTarget(s, "d/.polycode.env", "")).toEqual({ error: "reserved" })
  })

  it("duplicates a folder with its own texts, flags, roles and empty folders", () => {
    const s = new ProjectStore(false)
    createFile(s, "a/x.py", "x = 1")
    createFile(s, "a/t.test.py", "tests")
    createDir(s, "a/empty")
    createFile(s, "ab/other.py", "no")
    setFolderRole(s, "a", "ivan")
    setFlag(s, "a/x.py", "protected", true)
    expect(duplicatePath(s, "a")).toEqual({ to: "a copy" })
    expect(snapshotFiles(s)["a copy/x.py"]).toBe("x = 1")
    expect(metasOf(s).get("a copy/x.py")!.protected).toBe(true)
    expect(metasOf(s).get("a copy/t.test.py")!.hidden).toBe(true)
    expect(metasOf(s).has("ab copy/other.py")).toBe(false)
    expect(foldersOf(s).get("a copy")).toBe("ivan")
    expect(dirsOf(s).has("a copy/empty")).toBe(true)
    // The copy edits apart from the original.
    textOf(s, "a copy/x.py")!.insert(0, "# ")
    expect(snapshotFiles(s)["a/x.py"]).toBe("x = 1")
    expect(duplicatePath(s, "a")).toEqual({ to: "a copy 2" })
  })

  it("names a file's copy before its extension, keeping .test.py", () => {
    const s = new ProjectStore(false)
    createFile(s, "m/x.py", "1")
    createFile(s, "t.test.py", "")
    createFile(s, ".env", "")
    expect(duplicatePath(s, "m/x.py")).toEqual({ to: "m/x copy.py" })
    expect(duplicatePath(s, "t.test.py")).toEqual({ to: "t copy.test.py" })
    expect(duplicatePath(s, ".env")).toEqual({ to: ".env copy" })
  })

  it("hides new tests and moves folder roles on rename", () => {
    const s = new ProjectStore(false)
    createFile(s, "a/t.test.py", "")
    expect(metasOf(s).get("a/t.test.py")!.hidden).toBe(true)
    setFolderRole(s, "a", "ivan")
    renamePath(s, "a", "b")
    expect(foldersOf(s).toJSON()).toEqual({ b: "ivan" })
  })

  it("keeps access rules through an archive", async () => {
    const s = new ProjectStore(false)
    createFile(s, "s/ivan/a.py", "x")
    createFile(s, "t.test.py", "")
    setFolderRole(s, "s/ivan", "ivan")
    setFlag(s, "s/ivan/a.py", "protected", true)
    const zip = importZip(await exportZip(s))
    expect(zip.entries.map((e) => e.path)).not.toContain(".polycode.env")
    const t = new ProjectStore(false)
    await openArchive(t, zip)
    expect(foldersOf(t).toJSON()).toEqual({ "s/ivan": "ivan" })
    expect(metasOf(t).get("s/ivan/a.py")!.protected).toBe(true)
    expect(metasOf(t).get("t.test.py")!.hidden).toBe(true)
  })

  it("drops a deleted file's document", () => {
    const s = new ProjectStore(false)
    createFile(s, "x.py", "")
    const id = metasOf(s).get("x.py")!.id
    deletePath(s, "x.py")
    expect(s.ids()).not.toContain(`f:${id}`)
  })

  it("replaces the whole project", () => {
    const s = new ProjectStore(false)
    createFile(s, "old.py", "")
    replaceProject(s, { "new.py": "n" })
    expect(snapshotFiles(s)).toEqual({ "new.py": "n" })
  })

  it("opens a tournament's document when it appears in the structure and drops it with the entry", () => {
    const s = new ProjectStore(false)
    const tournaments = s.structure.getMap<{ private: boolean }>("tournaments")
    tournaments.set("abc", { private: false })
    expect(s.has("t:abc")).toBe(true)
    expect(s.ids()).toContain("t:abc")
    tournaments.delete("abc")
    expect(s.ids()).not.toContain("t:abc")
    expect(s.has("t:abc")).toBe(false)
  })

  it("gives every document the same client id", () => {
    const s = new ProjectStore(false)
    createFile(s, "x.py", "")
    expect(s.runtime.clientID).toBe(s.clientID)
    expect(s.doc(s.ids().find((i) => i.startsWith("f:"))!).clientID).toBe(s.clientID)
  })

  it("creates documents for files added by someone else", () => {
    const a = new ProjectStore(false)
    const b = new ProjectStore(false)
    createFile(a, "x.py", "hi")
    const seen: string[] = []
    b.onDoc((id) => seen.push(id))
    // Only the structure travels here; b learns about the file from it.
    Y.applyUpdate(b.structure, Y.encodeStateAsUpdate(a.structure))
    expect(seen).toEqual([`f:${metasOf(a).get("x.py")!.id}`])
  })
})

describe("reset and first start", () => {
  it("reset clears folder rules, freeze and presentation", () => {
    const s = new ProjectStore(false)
    createFile(s, "a/x.py", "")
    setFolderRole(s, "a", "ivan")
    stateOf(s).set("frozen", true)
    stateOf(s).set("presentation", { path: "x.pdf", page: 1, by: 1 })
    resetProject(s)
    expect(foldersOf(s).size).toBe(0)
    expect(stateOf(s).get("frozen")).toBeUndefined()
    expect(stateOf(s).get("presentation")).toBeUndefined()
  })

  it("sets a project up once: deleting every file later does not bring main.py back", async () => {
    const s = new ProjectStore(false)
    let migrations = 0
    const migrate = async () => {
      migrations++
      createFile(s, "main.py", "")
    }
    await setUp(s, migrate)
    deletePath(s, "main.py")
    await setUp(s, migrate)
    expect(migrations).toBe(1)
    expect(metasOf(s).size).toBe(0)
  })
})

describe("sealed files", () => {
  const SECRET_ID = "sealedsealedseal"
  const withSealed = (path = "t.test.py") => {
    const s = new ProjectStore(false)
    metasOf(s).set(path, { id: SECRET_ID, kind: "text", size: 6, sealed: true })
    return s
  }
  const context = (store: ProjectStore): AgentContext => ({
    store,
    provider: { isOwner: true } as CollabProvider,
    app: { moved: vi.fn(), open: vi.fn(), active: () => "main.py" } as unknown as AgentApp,
  })
  const answer = async (name: string, args: object, store: ProjectStore) => {
    const result = await runTool(name, args, context(store))
    return { error: !!result.isError, text: JSON.stringify(result.content) }
  }

  it("has no document: no text in Yjs or IndexedDB", () => {
    const s = withSealed()
    expect(s.has(`f:${SECRET_ID}`)).toBe(false)
    expect(s.ids()).not.toContain(`f:${SECRET_ID}`)
    const created: string[] = []
    s.onDoc((id) => created.push(id))
    createFile(s, "main.py", "")
    expect(created).toEqual([`f:${metasOf(s).get("main.py")!.id}`])
  })

  it("does not get one from someone else's structure either", () => {
    const a = withSealed()
    const b = new ProjectStore(false)
    Y.applyUpdate(b.structure, Y.encodeStateAsUpdate(a.structure))
    expect(b.has(`f:${SECRET_ID}`)).toBe(false)
  })

  it("is not in snapshotFiles, duplicates or flags", () => {
    const s = withSealed("a/t.test.py")
    createFile(s, "a/x.py", "x")
    expect(Object.keys(snapshotFiles(s))).toEqual(["a/x.py"])

    expect(duplicatePath(s, "a")).toEqual({ to: "a copy" })
    expect(metasOf(s).has("a copy/t.test.py")).toBe(false)
    expect(metasOf(s).has("a copy/x.py")).toBe(true)

    const before = metasOf(s).get("a/t.test.py")
    expect("error" in duplicatePath(s, "a/t.test.py")).toBe(true)
    expect(metasOf(s).size).toBe(3)

    // Its owner cannot show it or make it an ordinary file.
    setFlag(s, "a/t.test.py", "hidden", false)
    setFlag(s, "a/t.test.py", "protected", true)
    expect(metasOf(s).get("a/t.test.py")).toEqual(before)
  })

  // Review focus 3: whichever way the path gets taken, the old sealed file is gone.
  it("is replaced by createFile", () => {
    const s = withSealed()
    createFile(s, "t.test.py", "mine")
    const meta = metasOf(s).get("t.test.py")!
    expect(meta.sealed).toBeUndefined()
    expect(meta.id).not.toBe(SECRET_ID)
    expect(textOf(s, "t.test.py")!.toString()).toBe("mine")
  })

  it("is replaced by renamePath onto its path", () => {
    const s = withSealed()
    createFile(s, "mine.py", "my text")
    const id = metasOf(s).get("mine.py")!.id
    renamePath(s, "mine.py", "t.test.py")
    const meta = metasOf(s).get("t.test.py")!
    expect(meta.id).toBe(id)
    expect(meta.sealed).toBeUndefined()
    expect(textOf(s, "t.test.py")!.toString()).toBe("my text")
    expect(metasOf(s).has("mine.py")).toBe(false)
  })

  it("is replaced when a whole folder is renamed over it", () => {
    const s = withSealed("b/t.test.py")
    createFile(s, "a/t.test.py", "from a")
    renamePath(s, "a", "b")
    expect(metasOf(s).get("b/t.test.py")!.sealed).toBeUndefined()
    expect(textOf(s, "b/t.test.py")!.toString()).toBe("from a")
  })

  it("moves with its folder, still sealed, when nothing takes its path", () => {
    const s = withSealed("a/t.test.py")
    renamePath(s, "a", "b")
    expect(metasOf(s).get("b/t.test.py")).toMatchObject({ id: SECRET_ID, sealed: true })
    expect(s.has(`f:${SECRET_ID}`)).toBe(false)
  })

  it("is replaced by the agent's write_file, and read_file then gives the new text", async () => {
    const s = withSealed()
    const written = await answer("write_file", { path: "t.test.py", content: "agent text" }, s)
    expect(written.error).toBe(false)
    const meta = metasOf(s).get("t.test.py")!
    expect(meta.sealed).toBeUndefined()
    expect(meta.id).not.toBe(SECRET_ID)
    const read = await answer("read_file", { path: "t.test.py" }, s)
    expect(read.error).toBe(false)
    expect(read.text).toContain("agent text")
  })

  it("the agent's create_file takes its path as if it were free", async () => {
    const s = withSealed()
    expect((await answer("create_file", { path: "t.test.py", content: "new" }, s)).error).toBe(false)
    expect(metasOf(s).get("t.test.py")!.sealed).toBeUndefined()
  })

  it("the agent's read_file answers as for a file that does not exist", async () => {
    const seen = await answer("read_file", { path: "t.test.py" }, withSealed())
    const missing = await answer("read_file", { path: "t.test.py" }, new ProjectStore(false))
    expect(seen).toEqual(missing)
    expect(seen.error).toBe(true)
  })

  it("the agent's overview, list and search do not show it", async () => {
    const s = withSealed("hidden_test_name.test.py")
    createFile(s, "main.py", "needle")
    for (const [tool, args] of [
      ["project_overview", {}],
      ["list_files", {}],
      ["search_files", { query: "needle" }],
    ] as const) {
      const { text } = await answer(tool, args, s)
      expect(text).not.toContain("hidden_test_name")
      expect(text).not.toContain(SECRET_ID)
    }
  })
})
