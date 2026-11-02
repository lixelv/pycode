import { describe, expect, it } from "vitest"
import * as Y from "yjs"

import { ADMINS_ONLY } from "./access"
import { createDir, createFile, foldersOf, metasOf, packagesOf, renamePath, rolesOf, setFlag, setFolderRole, stateOf, tournamentsOf } from "./project"
import { hiddenManifest, placementOf, publicStructure } from "./publish"
import { type FileMeta, ProjectStore } from "./store"

const meta = (extra: Partial<FileMeta> = {}): FileMeta => ({ id: "x", kind: "text", size: 1, ...extra })

const raw = (bytes: Uint8Array) => new TextDecoder("latin1").decode(bytes)
const utf8raw = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const decoded = (bytes: Uint8Array) => {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, bytes)
  return doc
}
const paths = (doc: Y.Doc) => [...doc.getMap<FileMeta>("files").keys()].sort()

describe("placementOf", () => {
  it("puts a plain file in public", () => {
    expect(placementOf("main.py", meta(), {})).toBe("public")
    expect(placementOf("a/b/c.py", meta({ protected: true }), {})).toBe("public")
  })

  it("puts a hidden file in hidden", () => {
    expect(placementOf("t.test.py", meta({ hidden: true }), {})).toBe("hidden")
  })

  it("puts anything inside a role folder in private, at any depth", () => {
    const folders = { "s/ivan": "ivan" }
    expect(placementOf("s/ivan/a.py", meta(), folders)).toBe("private")
    expect(placementOf("s/ivan/deep/er/a.py", meta(), folders)).toBe("private")
  })

  it("treats @admins as a role folder", () => {
    expect(placementOf("keys/a.py", meta(), { keys: ADMINS_ONLY })).toBe("private")
  })

  it("looks at every role folder on the path, whatever the order of the keys", () => {
    expect(placementOf("a/b/c.py", meta(), { z: "r", a: "r" })).toBe("private")
    expect(placementOf("a/b/c.py", meta(), { "a/b": "r", q: "r" })).toBe("private")
    expect(placementOf("a/b/c.py", meta(), { q: "r", "a/b": "r" })).toBe("private")
  })

  it("does not take a neighbour with the same beginning", () => {
    expect(placementOf("ab/x.py", meta(), { a: "r" })).toBe("public")
    expect(placementOf("a", meta(), { a: "r" })).toBe("public")
    expect(placementOf("b/a/x.py", meta(), { a: "r" })).toBe("public")
  })

  // A hidden file in a role folder may be a student's work: a copy turns
  // hidden/ into sealed/, and role folders are not copied even as sealed.
  it("keeps a hidden file of a role folder private", () => {
    expect(placementOf("s/ivan/a.py", meta({ hidden: true }), { "s/ivan": "ivan" })).toBe("private")
  })

  it("keeps sealed in sealed, never public", () => {
    expect(placementOf("t.test.py", meta({ sealed: true }), {})).toBe("sealed")
    expect(placementOf("t.test.py", meta({ sealed: true, hidden: true }), {})).toBe("sealed")
    expect(placementOf("s/t.test.py", meta({ sealed: true }), { s: "ivan" })).toBe("sealed")
  })
})

describe("publicStructure", () => {
  it("keeps public files and their metadata", () => {
    const s = new ProjectStore(false)
    createFile(s, "main.py", "x")
    createFile(s, "a/b.py", "y", { protected: true })
    const doc = decoded(publicStructure(s.structure))
    expect(paths(doc)).toEqual(["a/b.py", "main.py"])
    expect(doc.getMap<FileMeta>("files").get("main.py")).toEqual(metasOf(s).get("main.py"))
    expect(doc.getMap<FileMeta>("files").get("a/b.py")!.protected).toBe(true)
  })

  it("leaves out hidden files, role folders, @admins and sealed files", () => {
    const s = new ProjectStore(false)
    createFile(s, "main.py", "x")
    createFile(s, "secret.test.py", "")
    createFile(s, "s/ivan/work.py", "")
    createFile(s, "keys/admin_key.py", "")
    metasOf(s).set("sealed_one.test.py", { id: "sealedidvalue", kind: "text", size: 1, sealed: true })
    setFolderRole(s, "s/ivan", "ivan")
    setFolderRole(s, "keys", ADMINS_ONLY)
    const bytes = publicStructure(s.structure)
    expect(paths(decoded(bytes))).toEqual(["main.py"])
    for (const name of ["secret.test.py", "s/ivan", "ivan", "work.py", "admin_key", "keys", "sealed_one", "sealedidvalue"]) {
      expect(raw(bytes)).not.toContain(name)
    }
  })

  it("has no trace of a path hidden after it was created", () => {
    const s = new ProjectStore(false)
    createFile(s, "was_public_answer.py", "x")
    const id = metasOf(s).get("was_public_answer.py")!.id
    setFlag(s, "was_public_answer.py", "hidden", true)
    // The history of the source document does hold the name: a filter over it would leak.
    expect(raw(Y.encodeStateAsUpdate(s.structure))).toContain("was_public_answer")
    const bytes = publicStructure(s.structure)
    expect(raw(bytes)).not.toContain("was_public_answer")
    expect(raw(bytes)).not.toContain(id)
  })

  it("has no trace of a deleted or renamed name", () => {
    const s = new ProjectStore(false)
    createFile(s, "old_name_of_it.py", "")
    renamePath(s, "old_name_of_it.py", "new.py")
    const bytes = publicStructure(s.structure)
    expect(raw(bytes)).not.toContain("old_name_of_it")
    expect(paths(decoded(bytes))).toEqual(["new.py"])
  })

  it("drops role names, the rules, tournaments and presentation: students' names live there", () => {
    const s = new ProjectStore(false)
    createFile(s, "main.py", "")
    rolesOf(s).set("petrov_ivan", "write")
    createFile(s, "st/vasya/a.py", "")
    foldersOf(s).set("st/vasya", "sidorova_anna")
    tournamentsOf(s).set("final_contest", { private: true })
    stateOf(s).set("presentation", { path: "lecture_secret.pdf", page: 1, by: 1 })
    stateOf(s).set("frozen", true)
    const bytes = publicStructure(s.structure)
    const text = utf8raw(bytes)
    for (const name of ["petrov_ivan", "sidorova_anna", "vasya", "final_contest", "lecture_secret"]) expect(text).not.toContain(name)
    const doc = decoded(bytes)
    expect(doc.getMap("roles").size).toBe(0)
    expect(doc.getMap("folders").size).toBe(0)
    expect(doc.getMap("tournaments").size).toBe(0)
    expect(doc.getMap("state").has("frozen")).toBe(false)
  })

  it("drops empty folders inside a role folder and keeps other folders", () => {
    const s = new ProjectStore(false)
    createDir(s, "docs")
    createDir(s, "s/ivan/empty_inner")
    createDir(s, "s/ivan")
    setFolderRole(s, "s/ivan", "ivan")
    const doc = decoded(publicStructure(s.structure))
    expect([...doc.getMap("dirs").keys()]).toEqual(["docs"])
  })

  it("keeps what running needs: languages and packages", () => {
    const s = new ProjectStore(false)
    createFile(s, "main.cpp", "")
    packagesOf(s).push([{ spec: "numpy", status: "installed" } as never])
    const doc = decoded(publicStructure(s.structure))
    expect(doc.getMap("state").get("languages")).toEqual(stateOf(s).get("languages"))
    expect(doc.getMap("state").get("languages")).toContain("cpp")
    expect(doc.getArray("packages").length).toBe(1)
  })

  it("is a clean document: the result of each call is whole, with no history", () => {
    const s = new ProjectStore(false)
    createFile(s, "a.py", "")
    // Built afresh: nothing in it was written under the source document's client.
    const clients = Y.decodeStateVector(Y.encodeStateVector(decoded(publicStructure(s.structure))))
    expect(clients.has(s.structure.clientID)).toBe(false)
    setFlag(s, "a.py", "hidden", true)
    expect(paths(decoded(publicStructure(s.structure)))).toEqual([])
  })
})

describe("hiddenManifest", () => {
  it("lists hidden files outside role folders, with their metadata and no flags", () => {
    const s = new ProjectStore(false)
    createFile(s, "main.py", "")
    createFile(s, "t.test.py", "abc")
    metasOf(s).set("p.png", { id: "pid", kind: "binary", size: 5, hash: "h".repeat(64), mime: "image/png", hidden: true })
    createFile(s, "s/ivan/h.py", "", { hidden: true })
    setFolderRole(s, "s/ivan", "ivan")
    metasOf(s).set("sealed.test.py", { id: "sid", kind: "text", size: 1, sealed: true })
    const list = hiddenManifest(s.structure).sort((a, b) => a.path.localeCompare(b.path))
    expect(list).toEqual([
      { path: "p.png", id: "pid", kind: "binary", size: 5, hash: "h".repeat(64), mime: "image/png" },
      { path: "t.test.py", id: metasOf(s).get("t.test.py")!.id, kind: "text", size: 3 },
    ])
  })
})
