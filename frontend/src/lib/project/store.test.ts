import { describe, expect, it } from "vitest"
import * as Y from "yjs"

import { createDir, createFile, deletePath, dirsOf, duplicatePath, exportZip, foldersOf, importZip, metasOf, moveTarget, openArchive, renamePath, replaceProject, resetProject, setFlag, setFolderRole, setUp, snapshotFiles, stateOf, textOf } from "./project"
import { ProjectStore } from "./store"

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
