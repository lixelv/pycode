import { describe, expect, it } from "vitest"

import { getBlob } from "./blobs"
import { addFiles, exportZip, importZip, isText, metasOf, openArchive, projectSize, PROJECT_LIMIT, textOf } from "./project"
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
