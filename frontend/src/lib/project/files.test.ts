import { strToU8, zipSync } from "fflate"
import { describe, expect, it } from "vitest"

import { getBlob } from "./blobs"
import { addFiles, createFile, exportZip, importZip, isCpp, isText, languageOf, metasOf, openArchive, packagesKind, projectSize, PROJECT_LIMIT, textOf } from "./project"
import { ProjectStore } from "./store"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const utf8 = (s: string) => new TextEncoder().encode(s)

describe("isText", () => {
  it("knows text by extension or by content", () => {
    expect(isText("a.py", utf8("x = 1"))).toBe(true)
    expect(isText("notes", utf8("hello\n"))).toBe(true)
    expect(isText("logo.png", PNG)).toBe(false)
    expect(isText("data.bin", new Uint8Array([0xff, 0xfe, 0, 1]))).toBe(false)
    // A PDF can be plain ASCII; its extension still makes it binary.
    expect(isText("doc.pdf", utf8("%PDF-1.4\n"))).toBe(false)
  })
})

describe("archives", () => {
  it("round-trip binary files", async () => {
    const s = new ProjectStore(false)
    await addFiles(s, "", [{ path: "logo.png", bytes: PNG }])
    const t = new ProjectStore(false)
    await openArchive(t, importZip(await exportZip(s)))
    expect(metasOf(t).get("logo.png")!.kind).toBe("binary")
    expect(await getBlob(metasOf(t).get("logo.png")!.hash!)).toEqual(PNG)
  })
})

describe("addFiles", () => {
  it("adds text as text and the rest as binary", async () => {
    const s = new ProjectStore(false)
    const res = await addFiles(s, "src", [
      { path: "a.py", bytes: utf8("print(1)") },
      { path: "img/logo.png", bytes: PNG },
    ])
    expect(res).toEqual({ added: ["src/a.py", "src/img/logo.png"] })
    expect(textOf(s, "src/a.py")!.toString()).toBe("print(1)")
    const meta = metasOf(s).get("src/img/logo.png")!
    expect(meta.kind).toBe("binary")
    expect(meta.size).toBe(PNG.length)
    expect(meta.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("does not overwrite: a taken name gets a number", async () => {
    const s = new ProjectStore(false)
    await addFiles(s, "", [{ path: "a.py", bytes: utf8("1") }])
    const res = await addFiles(s, "", [{ path: "a.py", bytes: utf8("2") }])
    expect(res).toEqual({ added: ["a (2).py"] })
  })

  it("refuses to go over the project limit", async () => {
    const s = new ProjectStore(false)
    const big = new Uint8Array(PROJECT_LIMIT - 10).fill(0)
    expect(await addFiles(s, "", [{ path: "big.bin", bytes: big }])).toEqual({ added: ["big.bin"] })
    expect(await addFiles(s, "", [{ path: "more.bin", bytes: new Uint8Array(100).fill(1) }])).toEqual({ error: "limit" })
    expect(metasOf(s).has("more.bin")).toBe(false)
  })

  it("counts the same bytes once", async () => {
    const s = new ProjectStore(false)
    const big = new Uint8Array(PROJECT_LIMIT - 10).fill(0)
    await addFiles(s, "", [{ path: "big.bin", bytes: big }])
    expect(await addFiles(s, "", [{ path: "copy.bin", bytes: big }])).toEqual({ added: ["copy.bin"] })
    expect(projectSize(s)).toBe(PROJECT_LIMIT - 10)
  })
})

describe("openArchive", () => {
  it("refuses an archive over the limit without touching the project", async () => {
    const s = new ProjectStore(false)
    createFile(s, "main.py", "keep")
    const result = await openArchive(s, { entries: [{ path: "big.bin", bytes: new Uint8Array(1) }], dirs: [], env: null, size: PROJECT_LIMIT + 1 })
    expect(result).toEqual({ error: "limit" })
    expect(textOf(s, "main.py")!.toString()).toBe("keep")
  })

  it("applies the access rules before any content exists", async () => {
    const s = new ProjectStore(false)
    const seen: string[] = []
    s.onDoc((id, doc) =>
      doc.on("update", () => {
        const path = [...metasOf(s).entries()].find(([, m]) => `f:${m.id}` === id)?.[0]
        const meta = path ? metasOf(s).get(path) : undefined
        seen.push(`${path}:${!!meta?.hidden}:${s.structure.getMap("folders").get("alice") ?? "-"}`)
      }),
    )
    const utf8 = (t: string) => new TextEncoder().encode(t)
    await openArchive(s, {
      entries: [
        { path: "alice/a.py", bytes: utf8("A") },
        { path: "notes.txt", bytes: utf8("N") },
      ],
      dirs: [],
      env: { roles: { alice: "write" }, folders: { alice: "alice" }, protected: [], hidden: ["notes.txt"] },
      size: 2,
    })
    expect(seen).toContain("alice/a.py:false:alice")
    expect(seen).toContain("notes.txt:true:alice")
  })
})

describe("legacy .pycode.env", () => {
  it("still hides files when an archive has only the old env name", async () => {
    const s = new ProjectStore(false)
    const zip = zipSync({ ".pycode.env": strToU8("hidden t.test.py\n"), "t.test.py": strToU8("x = 1") })
    await openArchive(s, importZip(zip))
    expect(metasOf(s).get("t.test.py")?.hidden).toBe(true)
  })
})

describe("exportZip", () => {
  it("leaves out (and reports) binary files it cannot get, instead of empty ones", async () => {
    const s = new ProjectStore(false)
    metasOf(s).set("gone.png", { id: "g", kind: "binary", size: 10, hash: "f".repeat(64), mime: "image/png" })
    const missing: string[] = []
    const zip = importZip(await exportZip(s, undefined, missing))
    expect(missing).toEqual(["gone.png"])
    expect(zip.entries.map((e) => e.path)).not.toContain("gone.png")
  })
})

describe("packages by language", () => {
  it("tells which packages system a file uses", () => {
    expect(packagesKind("a/b.py")).toBe("python")
    expect(packagesKind("x.hpp")).toBe("cpp")
    expect(packagesKind("index.html")).toBeNull()
  })

  it("knows C++ by extension", () => {
    expect(languageOf("main.cc")).toBe("cpp")
    expect(isCpp("x.hpp")).toBe(true)
    expect(isCpp("a.py")).toBe(false)
  })
})
