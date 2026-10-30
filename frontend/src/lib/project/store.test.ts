import { describe, expect, it } from "vitest"
import * as Y from "yjs"

import { applyEnv, createFile, deletePath, exportZip, foldersOf, importZip, metasOf, setFlag, setFolderRole, renamePath, replaceProject, snapshotFiles, textOf } from "./project"
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

  it("hides new tests and moves folder roles on rename", () => {
    const s = new ProjectStore(false)
    createFile(s, "a/t.test.py", "")
    expect(metasOf(s).get("a/t.test.py")!.hidden).toBe(true)
    setFolderRole(s, "a", "ivan")
    renamePath(s, "a", "b")
    expect(foldersOf(s).toJSON()).toEqual({ b: "ivan" })
  })

  it("keeps access rules through an archive", () => {
    const s = new ProjectStore(false)
    createFile(s, "s/ivan/a.py", "x")
    createFile(s, "t.test.py", "")
    setFolderRole(s, "s/ivan", "ivan")
    setFlag(s, "s/ivan/a.py", "protected", true)
    const zip = importZip(exportZip(s))
    expect(zip.files).not.toHaveProperty(".pycode.env")
    const t = new ProjectStore(false)
    replaceProject(t, zip.files, zip.dirs)
    applyEnv(t, zip.env!)
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
