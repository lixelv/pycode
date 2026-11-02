import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Y from "yjs"

import { addFiles, createFile, deletePath, foldersOf, metasOf, renamePath, resetProject, setFlag, setFolderRole, snapshotFiles, textOf, tournamentsOf } from "./project"
import { publicStructure } from "./publish"
import { ProjectSaver } from "./saver"
import { type FileMeta, ProjectStore } from "./store"

/*
 * The cloud as ProjectSaver sees it (cloud.ts turns these into presign requests
 * and gzip): keys are relative to the project, bytes are uncompressed, a failure
 * is an error with a numeric `status`.
 */
class FakeCloud {
  objects = new Map<string, Uint8Array>()
  /** Every write and removal in order: "put key", "del key". */
  log: string[] = []
  gets: string[] = []
  tokens = new Set<string>()
  dropped: string[] = []
  gone = false
  down = false
  /** Keys whose put or remove fails with 500. */
  failing = new Set<string>()
  /** Holds a put of a key until released. */
  held = new Map<string, () => void>()
  holdKeys = new Set<string>()
  inFlight = new Map<string, number>()
  maxInFlight = 0

  private check(key?: string) {
    if (this.gone) throw Object.assign(new Error("gone"), { status: 404 })
    if (this.down || (key && this.failing.has(key))) throw Object.assign(new Error("down"), { status: 500 })
  }

  async get(key: string): Promise<Uint8Array | null> {
    this.gets.push(key)
    this.check()
    return this.objects.get(key) ?? null
  }

  async put(key: string, bytes: Uint8Array, token: string): Promise<void> {
    this.check(key)
    this.tokens.add(token)
    const running = (this.inFlight.get(key) ?? 0) + 1
    this.inFlight.set(key, running)
    this.maxInFlight = Math.max(this.maxInFlight, running)
    if (this.holdKeys.has(key)) await new Promise<void>((done) => this.held.set(key, done))
    this.inFlight.set(key, running - 1)
    this.check(key)
    this.objects.set(key, bytes)
    this.log.push(`put ${key}`)
  }

  async remove(key: string, token: string): Promise<void> {
    this.check(key)
    this.tokens.add(token)
    this.objects.delete(key)
    this.log.push(`del ${key}`)
  }

  async keys(): Promise<{ key: string; size: number }[]> {
    this.check()
    return [...this.objects].map(([key, bytes]) => ({ key, size: bytes.length }))
  }

  async dropSealed(paths: string[], token: string): Promise<void> {
    this.check()
    this.tokens.add(token)
    this.dropped.push(...paths)
  }

  structureNames(key = "public/structure.ybin.gz") {
    const doc = new Y.Doc()
    const bytes = this.objects.get(key)
    if (bytes) Y.applyUpdate(doc, bytes)
    return [...doc.getMap<FileMeta>("files").keys()].sort()
  }

  writes() {
    return this.log.filter((l) => l.startsWith("put "))
  }
}

const TOKEN = "saver-token"
const FILE = (id: string, where = "public") => `${where}/f/${id}.ybin.gz`

function setup() {
  const store = new ProjectStore(false)
  const cloud = new FakeCloud()
  const saver = new ProjectSaver("project-1", store, cloud as never)
  return { store, cloud, saver }
}

/** Ready and saving, with everything so far written. */
async function saving() {
  const parts = setup()
  await parts.saver.load()
  parts.saver.setToken(TOKEN)
  return parts
}

const idOf = (s: ProjectStore, path: string) => metasOf(s).get(path)!.id
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("saving after an edit", () => {
  it("waits 2 seconds after the last edit", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "a.py", "1")
    await wait(10)
    await saver.flush()
    cloud.log = []
    const text = textOf(store, "a.py")!
    const key = FILE(idOf(store, "a.py"))

    text.insert(0, "x")
    await wait(1999)
    expect(cloud.writes()).not.toContain(`put ${key}`)
    await wait(1)
    expect(cloud.writes()).toContain(`put ${key}`)
  })

  it("starts the 2 seconds over on each edit", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "a.py", "1")
    await saver.flush()
    cloud.log = []
    const text = textOf(store, "a.py")!
    const key = FILE(idOf(store, "a.py"))

    text.insert(0, "x")
    await wait(1500)
    text.insert(0, "y")
    await wait(1999)
    expect(cloud.writes()).not.toContain(`put ${key}`)
    await wait(1)
    expect(cloud.writes()).toEqual([`put ${key}`])
  })

  it("saves a document one write at a time and does not lose an edit made during one", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "a.py", "1")
    await saver.flush()
    const key = FILE(idOf(store, "a.py"))
    cloud.holdKeys.add(key)
    cloud.log = []
    cloud.maxInFlight = 0
    const text = textOf(store, "a.py")!

    text.insert(0, "first ")
    await wait(2000)
    expect(cloud.held.has(key)).toBe(true)
    text.insert(0, "second ")
    await wait(10_000)
    expect(cloud.maxInFlight).toBe(1)

    cloud.holdKeys.clear()
    cloud.held.get(key)!()
    await wait(10_000)
    const doc = new Y.Doc()
    Y.applyUpdate(doc, cloud.objects.get(key)!)
    expect(doc.getText("t").toString()).toBe("second first 1")
  })

  it("reports saving and saved, and never stores the runtime document", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "a.py", "1")
    store.runtime.getText("terminal").insert(0, "output")
    store.runtime.getMap("run").set("status", "running")
    await wait(2000)
    await saver.flush()
    expect(saver.status).toBe("saved")
    expect([...cloud.objects.keys()].filter((k) => k.includes("runtime"))).toEqual([])
    cloud.log = []
    store.runtime.getText("terminal").insert(0, "more")
    await wait(10_000)
    expect(cloud.log).toEqual([])
  })

  it("writes each document under its key, the full structure in private and the filtered one in public", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "main.py", "print(1)")
    createFile(store, "t.test.py", "secret")
    store.board.getMap("elements").set("e", { id: "e" })
    tournamentsOf(store).set("контест 1", { private: false })
    store.doc("t:контест 1").getMap("results").set("u/a", { points: 1 })
    await saver.flush()
    const keys = [...cloud.objects.keys()]
    expect(keys).toContain(FILE(idOf(store, "main.py")))
    expect(keys).toContain(FILE(idOf(store, "t.test.py"), "hidden"))
    expect(keys).toContain("public/board.ybin.gz")
    expect(cloud.structureNames("private/structure.ybin.gz")).toEqual(["main.py", "t.test.py"])
    expect(cloud.structureNames()).toEqual(["main.py"])
    const table = keys.find((k) => k.startsWith("private/t/"))!
    expect(table).toMatch(/^private\/t\/[A-Za-z0-9_-]+\.ybin\.gz$/)
    const id = table.slice("private/t/".length, -".ybin.gz".length)
    expect(new TextDecoder().decode(Uint8Array.from(atob(id.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))).toBe("контест 1")
    expect(cloud.tokens).toEqual(new Set([TOKEN]))
  })

  it("removes a deleted file's object with the structure", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "a.py", "1")
    await saver.flush()
    const key = FILE(idOf(store, "a.py"))
    expect(cloud.objects.has(key)).toBe(true)
    deletePath(store, "a.py")
    await wait(2000)
    await saver.flush()
    expect(cloud.objects.has(key)).toBe(false)
    expect(cloud.structureNames()).toEqual([])
    expect(cloud.structureNames("private/structure.ybin.gz")).toEqual([])
  })

  it("flush writes at once, and fails when the save fails", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "a.py", "1")
    await saver.flush() // without any waiting
    expect(cloud.objects.has(FILE(idOf(store, "a.py")))).toBe(true)
    textOf(store, "a.py")!.insert(0, "2")
    cloud.down = true
    await expect(saver.flush()).rejects.toThrow()
    expect(saver.status).toBe("unsaved")
  })
})

describe("who writes", () => {
  it("does not write without the saver's token", async () => {
    const { store, cloud, saver } = setup()
    await saver.load()
    saver.setToken(null)
    createFile(store, "a.py", "1")
    textOf(store, "a.py")!.insert(0, "x")
    setFlag(store, "a.py", "hidden", true)
    await wait(60_000)
    expect(cloud.log).toEqual([])
  })

  it("stops when the token is taken away, even with a save pending", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "a.py", "1")
    await saver.flush()
    cloud.log = []
    textOf(store, "a.py")!.insert(0, "x")
    saver.setToken(null)
    await wait(60_000)
    expect(cloud.log).toEqual([])
  })

  it("writes what waited once the token comes (a guest's edits when the owner returns)", async () => {
    const { store, cloud, saver } = setup()
    await saver.load()
    createFile(store, "a.py", "from a guest")
    await wait(10_000)
    expect(cloud.log).toEqual([])
    saver.setToken(TOKEN)
    await wait(2000)
    const key = FILE(idOf(store, "a.py"))
    expect(cloud.objects.has(key)).toBe(true)
  })

  it("uses the newest token", async () => {
    const { store, cloud, saver } = await saving()
    saver.setToken("next")
    cloud.tokens.clear()
    createFile(store, "a.py", "1")
    await saver.flush()
    expect(cloud.tokens).toEqual(new Set(["next"]))
  })
})

describe("the prefix follows the file", () => {
  it("hiding is saved at once: the new object first, then the old one removed", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "a.py", "1")
    await saver.flush()
    const id = idOf(store, "a.py")
    cloud.log = []

    setFlag(store, "a.py", "hidden", true)
    await wait(50) // far less than the 2 seconds of an edit

    const put = cloud.log.indexOf(`put ${FILE(id, "hidden")}`)
    const del = cloud.log.indexOf(`del ${FILE(id)}`)
    expect(put).toBeGreaterThanOrEqual(0)
    expect(del).toBeGreaterThan(put)
    expect(cloud.objects.has(FILE(id))).toBe(false)
    expect(cloud.structureNames()).toEqual([])
    const manifest = JSON.parse(new TextDecoder().decode(cloud.objects.get("hidden/manifest.json.gz")!))
    expect(manifest).toEqual([{ path: "a.py", id, kind: "text", size: 1 }])
    expect(saver.status).toBe("saved")
  })

  it("showing a hidden file moves it back", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "t.test.py", "x")
    await saver.flush()
    const id = idOf(store, "t.test.py")
    expect(cloud.objects.has(FILE(id, "hidden"))).toBe(true)

    setFlag(store, "t.test.py", "hidden", false)
    await wait(50)
    expect(cloud.objects.has(FILE(id))).toBe(true)
    expect(cloud.objects.has(FILE(id, "hidden"))).toBe(false)
    expect(cloud.structureNames()).toEqual(["t.test.py"])
    expect(JSON.parse(new TextDecoder().decode(cloud.objects.get("hidden/manifest.json.gz")!))).toEqual([])
  })

  // Review focus 1.
  it("a hide that fails to remove the old object says unsaved and retries until it is gone", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "a.py", "1")
    await saver.flush()
    const id = idOf(store, "a.py")
    const old = FILE(id)

    cloud.failing.add(old)
    setFlag(store, "a.py", "hidden", true)
    await wait(50)
    expect(saver.status).toBe("unsaved")
    expect(cloud.objects.has(old)).toBe(true)
    await wait(30_000)
    expect(saver.status).toBe("unsaved")

    cloud.failing.clear()
    await wait(120_000)
    expect(cloud.objects.has(old)).toBe(false)
    expect(cloud.objects.has(FILE(id, "hidden"))).toBe(true)
    expect(saver.status).toBe("saved")
  })

  it("a hide that fails to write public/structure does not leave the name there quietly", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "a.py", "1")
    await saver.flush()

    cloud.failing.add("public/structure.ybin.gz")
    setFlag(store, "a.py", "hidden", true)
    await wait(50)
    expect(saver.status).toBe("unsaved")
    expect(cloud.structureNames()).toEqual(["a.py"]) // still there, and the footer says so

    cloud.failing.clear()
    await wait(120_000)
    expect(cloud.structureNames()).toEqual([])
    expect(saver.status).toBe("saved")
  })

  it("when everything is down the hide is retried after it returns", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "a.py", "1")
    await saver.flush()
    const id = idOf(store, "a.py")

    cloud.down = true
    setFlag(store, "a.py", "hidden", true)
    await wait(120_000)
    expect(saver.status).toBe("unsaved")
    cloud.down = false
    await wait(120_000)
    expect(cloud.objects.has(FILE(id))).toBe(false)
    expect(saver.status).toBe("saved")
  })

  // Review focus 2.
  it("renaming a file into a role folder moves its object to private and its name out of public", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "s/ivan/keep.py", "k")
    setFolderRole(store, "s/ivan", "ivan")
    createFile(store, "work_of_ivan.py", "w")
    await saver.flush()
    const id = idOf(store, "work_of_ivan.py")
    expect(cloud.objects.has(FILE(id))).toBe(true)

    renamePath(store, "work_of_ivan.py", "s/ivan/work_of_ivan.py")
    await wait(50)

    expect(cloud.objects.has(FILE(id, "private"))).toBe(true)
    expect(cloud.objects.has(FILE(id))).toBe(false)
    expect(cloud.structureNames()).toEqual([])
    expect(new TextDecoder("latin1").decode(cloud.objects.get("public/structure.ybin.gz")!)).not.toContain("work_of_ivan")
    expect(cloud.structureNames("private/structure.ybin.gz")).toEqual(["s/ivan/keep.py", "s/ivan/work_of_ivan.py"])
  })

  it("giving a role to a full folder moves everything inside, binary files too", async () => {
    vi.useRealTimers() // sha256 runs outside the fake clock
    const store = new ProjectStore(false)
    await addFiles(store, "group", [{ path: "photo.png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]) }])
    createFile(store, "group/a.py", "1")
    createFile(store, "group/inner/b.py", "2")
    createFile(store, "outside.py", "3")
    const cloud = new FakeCloud()
    const saver = new ProjectSaver("project-1", store, cloud as never)
    await saver.load()
    saver.setToken(TOKEN)
    await saver.flush()
    const hash = metasOf(store).get("group/photo.png")!.hash!
    expect(cloud.objects.has(`public/b/${hash}.gz`)).toBe(true)

    setFolderRole(store, "group", "ivan")
    await saver.flush()

    for (const path of ["group/a.py", "group/inner/b.py"]) {
      const id = idOf(store, path)
      expect(cloud.objects.has(FILE(id, "private"))).toBe(true)
      expect(cloud.objects.has(FILE(id))).toBe(false)
    }
    expect(cloud.objects.has(`private/b/${hash}.gz`)).toBe(true)
    expect(cloud.objects.has(`public/b/${hash}.gz`)).toBe(false)
    expect(cloud.objects.has(FILE(idOf(store, "outside.py")))).toBe(true)
    expect(cloud.structureNames()).toEqual(["outside.py"])

    // And back.
    setFolderRole(store, "group", null)
    expect(foldersOf(store).size).toBe(0)
    await saver.flush()
    expect(cloud.objects.has(`public/b/${hash}.gz`)).toBe(true)
    expect(cloud.objects.has(`private/b/${hash}.gz`)).toBe(false)
  })

  it("keeps a public blob another public file still uses when one of the two is hidden", async () => {
    vi.useRealTimers()
    const store = new ProjectStore(false)
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7])
    await addFiles(store, "", [
      { path: "one.png", bytes },
      { path: "two.png", bytes },
    ])
    const cloud = new FakeCloud()
    const saver = new ProjectSaver("project-1", store, cloud as never)
    await saver.load()
    saver.setToken(TOKEN)
    await saver.flush()
    const hash = metasOf(store).get("one.png")!.hash!

    setFlag(store, "one.png", "hidden", true)
    await saver.flush()
    expect(cloud.objects.has(`hidden/b/${hash}.gz`)).toBe(true)
    expect(cloud.objects.has(`public/b/${hash}.gz`)).toBe(true) // two.png needs it

    deletePath(store, "two.png")
    await saver.flush()
    expect(cloud.objects.has(`public/b/${hash}.gz`)).toBe(false)
    expect(cloud.objects.has(`hidden/b/${hash}.gz`)).toBe(true)
  })
})

describe("opening", () => {
  /** What another device left in S3: a real structure and a real text. */
  function otherDevice(cloud: FakeCloud, path: string, content: string) {
    const other = new ProjectStore(false)
    createFile(other, path, content)
    cloud.objects.set("private/structure.ybin.gz", Y.encodeStateAsUpdate(other.structure))
    cloud.objects.set("public/structure.ybin.gz", publicStructure(other.structure))
    const id = metasOf(other).get(path)!.id
    cloud.objects.set(FILE(id), Y.encodeStateAsUpdate(other.doc(`f:${id}`)))
    return { other, id }
  }

  it("brings a project in from S3 on a clean browser", async () => {
    const { store, cloud, saver } = setup()
    otherDevice(cloud, "main.py", "print('saved')")
    await saver.load()
    expect(snapshotFiles(store)).toEqual({ "main.py": "print('saved')" })
  })

  it("merges local edits with the server's copy: neither side loses anything", async () => {
    const { store, cloud, saver } = setup()
    const { other, id } = otherDevice(cloud, "main.py", "base")
    // This browser had the same file and edited it offline...
    Y.applyUpdate(store.structure, Y.encodeStateAsUpdate(other.structure))
    Y.applyUpdate(store.doc(`f:${id}`), Y.encodeStateAsUpdate(other.doc(`f:${id}`)))
    textOf(store, "main.py")!.insert(4, " local")
    createFile(store, "local_only.py", "L")
    // ...and the other device went on too.
    other.doc(`f:${id}`).getText("t").insert(0, "remote ")
    createFile(other, "remote_only.py", "R")
    const rid = metasOf(other).get("remote_only.py")!.id
    cloud.objects.set("private/structure.ybin.gz", Y.encodeStateAsUpdate(other.structure))
    cloud.objects.set(FILE(id), Y.encodeStateAsUpdate(other.doc(`f:${id}`)))
    cloud.objects.set(FILE(rid), Y.encodeStateAsUpdate(other.doc(`f:${rid}`)))

    await saver.load()

    expect(snapshotFiles(store)).toEqual({
      "main.py": "remote base local",
      "local_only.py": "L",
      "remote_only.py": "R",
    })
  })

  // public/structure is rebuilt in a clean document: merged into the owner's,
  // its entries would bring back what was deleted or hidden since.
  it("does not let a stale public/structure bring back a deleted file or undo a hide", async () => {
    const { store, cloud, saver } = setup()
    const { other } = otherDevice(cloud, "gone.py", "x")
    createFile(other, "hide_me.py", "y")
    cloud.objects.set("public/structure.ybin.gz", publicStructure(other.structure))
    deletePath(other, "gone.py")
    setFlag(other, "hide_me.py", "hidden", true)
    cloud.objects.set("private/structure.ybin.gz", Y.encodeStateAsUpdate(other.structure))

    await saver.load()

    expect(metasOf(store).has("gone.py")).toBe(false)
    expect(metasOf(store).get("hide_me.py")!.hidden).toBe(true)
  })

  it("works on the local copy when S3 is down, and says unsaved", async () => {
    const { store, cloud, saver } = setup()
    createFile(store, "main.py", "local")
    cloud.down = true
    await saver.load()
    expect(snapshotFiles(store)).toEqual({ "main.py": "local" })
    expect(saver.status).toBe("unsaved")
  })

  it("fails when S3 is down and there is no local copy", async () => {
    const { cloud, saver } = setup()
    cloud.down = true
    await expect(saver.load()).rejects.toThrow()
  })

  it("does not write while loading what it has just read", async () => {
    const { cloud, saver } = setup()
    otherDevice(cloud, "main.py", "saved")
    saver.setToken(TOKEN)
    await saver.load()
    cloud.log = []
    await wait(1000)
    expect(cloud.log.filter((l) => l.startsWith("del "))).toEqual([])
  })

  it("builds a copy's first structure from public/structure and the sealed manifest", async () => {
    const { store, cloud, saver } = setup()
    const source = new ProjectStore(false)
    createFile(source, "main.py", "open")
    const id = idOf(source, "main.py")
    cloud.objects.set("public/structure.ybin.gz", publicStructure(source.structure))
    cloud.objects.set(FILE(id), Y.encodeStateAsUpdate(source.doc(`f:${id}`)))
    cloud.objects.set(
      "sealed/manifest.json.gz",
      new TextEncoder().encode(
        JSON.stringify([
          { path: "main.test.py", id: "sealedid", kind: "text", size: 9 },
          { path: "data.bin", id: "sb", kind: "binary", size: 3, hash: "a".repeat(64), mime: "application/octet-stream" },
        ]),
      ),
    )
    cloud.objects.set(FILE("sealedid", "sealed"), new Uint8Array([1, 2, 3]))

    await saver.load()

    expect(snapshotFiles(store)).toEqual({ "main.py": "open" })
    expect(metasOf(store).get("main.test.py")).toMatchObject({ id: "sealedid", kind: "text", sealed: true })
    expect(metasOf(store).get("data.bin")).toMatchObject({ hash: "a".repeat(64), sealed: true })
    // Nothing of a sealed file comes in: no text, no document.
    expect(store.has("f:sealedid")).toBe(false)
    expect(cloud.gets).not.toContain(FILE("sealedid", "sealed"))
    expect(cloud.gets.filter((k) => k.startsWith("sealed/f/") || k.startsWith("sealed/b/"))).toEqual([])

    // The copy now has a structure of its own, and sealed/ stays untouched.
    saver.setToken(TOKEN)
    await saver.flush()
    expect(cloud.objects.has("private/structure.ybin.gz")).toBe(true)
    expect(cloud.structureNames()).toEqual(["main.py"])
    expect(cloud.log.filter((l) => l.includes(" sealed/"))).toEqual([])
    expect(cloud.objects.has(FILE("sealedid", "sealed"))).toBe(true)
  })
})

describe("sealed files in saving", () => {
  function sealedCopy() {
    const parts = setup()
    metasOf(parts.store).set("t.test.py", { id: "sealedid", kind: "text", size: 3, sealed: true })
    parts.cloud.objects.set(FILE("sealedid", "sealed"), new Uint8Array([1, 2, 3]))
    parts.cloud.objects.set("sealed/manifest.json.gz", new TextEncoder().encode(JSON.stringify([{ path: "t.test.py", id: "sealedid", kind: "text", size: 3 }])))
    return parts
  }

  it("never writes under sealed/, and leaves sealed files out of public and hidden", async () => {
    const { store, cloud, saver } = sealedCopy()
    await saver.load()
    saver.setToken(TOKEN)
    createFile(store, "main.py", "1")
    await saver.flush()
    expect(cloud.log.filter((l) => l.includes(" sealed/"))).toEqual([])
    expect(cloud.structureNames()).toEqual(["main.py"])
    expect(JSON.parse(new TextDecoder().decode(cloud.objects.get("hidden/manifest.json.gz")!))).toEqual([])
    expect(cloud.dropped).toEqual([])
  })

  // Review focus 3: the entry and the objects go, through the server.
  it("asks the server to drop a sealed file when its path is taken by a new file", async () => {
    const { store, cloud, saver } = sealedCopy()
    await saver.load()
    saver.setToken(TOKEN)
    createFile(store, "t.test.py", "mine now", { hidden: true })
    await saver.flush()
    expect(cloud.dropped).toEqual(["t.test.py"])
    const id = idOf(store, "t.test.py")
    expect(id).not.toBe("sealedid")
    expect(cloud.objects.has(FILE(id, "hidden"))).toBe(true)
    expect(cloud.log.filter((l) => l.includes(" sealed/"))).toEqual([])
  })
})

// Review focus 5.
describe("a project deleted elsewhere", () => {
  it("a 404 while saving stops all writing and erases the local copy", async () => {
    const { store, cloud, saver } = await saving()
    const clear = vi.spyOn(store, "clearStorage")
    createFile(store, "a.py", "1")
    await saver.flush()
    cloud.log = []

    cloud.gone = true
    textOf(store, "a.py")!.insert(0, "x")
    await wait(2000)
    await wait(10)
    expect(clear).toHaveBeenCalledTimes(1)

    cloud.gone = false // were it asked again, the fake would take the write
    textOf(store, "a.py")!.insert(0, "y")
    setFlag(store, "a.py", "hidden", true)
    saver.setToken("newer")
    await wait(600_000)
    expect(cloud.log).toEqual([])
  })

  it("a 404 at flush rejects and stops", async () => {
    const { store, cloud, saver } = await saving()
    const clear = vi.spyOn(store, "clearStorage")
    createFile(store, "a.py", "1")
    cloud.gone = true
    await expect(saver.flush()).rejects.toThrow()
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it("opening after the delete erases the local copy and does not bring the project back", async () => {
    const { store, cloud, saver } = setup()
    const clear = vi.spyOn(store, "clearStorage")
    createFile(store, "from_indexeddb.py", "old")
    cloud.gone = true
    await expect(saver.load()).rejects.toThrow()
    expect(clear).toHaveBeenCalledTimes(1)
    cloud.gone = false
    saver.setToken(TOKEN)
    await wait(600_000)
    expect(cloud.log).toEqual([])
  })

  it("a 500 is not a delete: nothing is erased", async () => {
    const { store, cloud, saver } = await saving()
    const clear = vi.spyOn(store, "clearStorage")
    createFile(store, "a.py", "1")
    cloud.down = true
    await wait(2000)
    await wait(10)
    expect(clear).not.toHaveBeenCalled()
    expect(saver.status).toBe("unsaved")
  })
})

describe("after the review", () => {
  // A tab that becomes the saver did not see what the previous one wrote.
  it("a tab that takes over learns what is in S3, and hiding then removes the old object", async () => {
    const { store, cloud, saver } = setup()
    await saver.load()
    const before = new ProjectStore(false)
    createFile(before, "t.py", "x")
    Y.applyUpdate(store.structure, Y.encodeStateAsUpdate(before.structure))
    const id = idOf(store, "t.py")
    cloud.objects.set(FILE(id), new Uint8Array([1])) // written by the tab that was the saver
    saver.setToken(TOKEN)
    await wait(10)
    setFlag(store, "t.py", "hidden", true)
    await wait(50)
    await saver.flush()
    expect(cloud.objects.has(FILE(id))).toBe(false)
    expect(cloud.objects.has(FILE(id, "hidden"))).toBe(true)
  })

  it("taking over heals a file left in the wrong place", async () => {
    const { store, cloud, saver } = setup()
    createFile(store, "t.test.py", "x") // hidden
    await saver.load()
    const id = idOf(store, "t.test.py")
    cloud.objects.set(FILE(id), new Uint8Array([1]))
    saver.setToken(TOKEN)
    await wait(50)
    expect(cloud.objects.has(FILE(id))).toBe(false)
  })

  it("writes the full structure last: an interrupted save is seen as unfinished", async () => {
    const { store, cloud, saver } = await saving()
    createFile(store, "a.py", "1")
    await saver.flush()
    cloud.log = []
    cloud.failing.add(FILE(idOf(store, "a.py")))
    setFlag(store, "a.py", "hidden", true)
    await wait(50)
    expect(cloud.log).not.toContain("put private/structure.ybin.gz")
  })

  it("going public from a tab that is not saving is refused", async () => {
    const { saver } = setup()
    await saver.load()
    await expect(saver.reconcile()).rejects.toThrow()
  })

  it("says unsaved when an edit has nobody to save it, and saved when another tab does", async () => {
    const { store, saver } = setup()
    await saver.load()
    saver.setToken(null, false)
    createFile(store, "a.py", "1")
    expect(saver.status).toBe("unsaved")
    saver.setToken(null, true)
    expect(saver.status).toBe("saved")
  })

  it("a reset keeps a sealed test; only a new file under its path replaces it", async () => {
    const { store, cloud, saver } = setup()
    metasOf(store).set("t.test.py", { id: "sealedid", kind: "text", size: 3, sealed: true })
    cloud.objects.set("sealed/manifest.json.gz", new TextEncoder().encode(JSON.stringify([{ path: "t.test.py", id: "sealedid", kind: "text", size: 3 }])))
    await saver.load()
    saver.setToken(TOKEN)
    createFile(store, "main.py", "1")
    resetProject(store)
    deletePath(store, "t.test.py")
    await saver.flush()
    expect(metasOf(store).get("t.test.py")?.sealed).toBe(true)
    expect(cloud.dropped).toEqual([])
  })
})
