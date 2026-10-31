import { strToU8, zipSync } from "fflate"
import { describe, expect, it } from "vitest"

import { getBlob } from "./blobs"
import { addFiles, addLanguagesFor, createFile, deletePath, ensureTournament, exportZip, importZip, isCpp, isText, languageOf, languagesOf, metasOf, needsLanguage, openArchive, packagesKind, projectSize, PROJECT_LIMIT, replaceProject, resetProject, startProject, STARTERS, stateOf, testPathOf, textOf, tournamentsOf } from "./project"
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

describe("project languages", () => {
  it("an empty project needs a language and defaults to python", () => {
    const s = new ProjectStore(false)
    expect(needsLanguage(s)).toBe(true)
    expect(languagesOf(s)).toEqual(["python"])
  })

  it("starters: main.py and main.cpp", () => {
    expect(STARTERS.python.path).toBe("main.py")
    expect(STARTERS.cpp.path).toBe("main.cpp")
    expect(STARTERS.cpp.code).toContain("std::getline")
  })

  it("startProject writes the language and the starter file", () => {
    const s = new ProjectStore(false)
    startProject(s, "cpp")
    expect(metasOf(s).has("main.cpp")).toBe(true)
    expect(languagesOf(s)).toEqual(["cpp"])
    expect(needsLanguage(s)).toBe(false)
  })

  it("adds languages in order and never removes them", () => {
    const s = new ProjectStore(false)
    startProject(s, "cpp")
    createFile(s, "a.py", "")
    expect(languagesOf(s)).toEqual(["cpp", "python"])
    deletePath(s, "a.py")
    expect(languagesOf(s)).toEqual(["cpp", "python"])
  })

  it("infers both languages for an old project without languages", () => {
    const s = new ProjectStore(false)
    createFile(s, "x.cpp", "")
    createFile(s, "y.py", "")
    s.structure.transact(() => stateOf(s).delete("languages"))
    expect(languagesOf(s).sort()).toEqual(["cpp", "python"])
  })

  it("reset leaves no files and asks for a language again", () => {
    const s = new ProjectStore(false)
    startProject(s, "python")
    resetProject(s)
    expect(metasOf(s).size).toBe(0)
    expect(needsLanguage(s)).toBe(true)
  })

  it("a C++ header added to a python project adds cpp", async () => {
    const s = new ProjectStore(false)
    startProject(s, "python")
    createFile(s, "lib.hpp", "")
    expect(languagesOf(s)).toEqual(["python", "cpp"])
    const t = new ProjectStore(false)
    startProject(t, "python")
    await addFiles(t, "", [{ path: "lib.hpp", bytes: utf8("") }])
    expect(languagesOf(t)).toEqual(["python", "cpp"])
    addLanguagesFor(t, ["b.py"])
    expect(languagesOf(t)).toEqual(["python", "cpp"])
  })

  it("an opened archive replaces the languages with its own", async () => {
    const s = new ProjectStore(false)
    startProject(s, "python")
    const zip = importZip(zipSync({ "main.cpp": strToU8("int main() {}\n"), "lib.h": strToU8("") }))
    await openArchive(s, zip)
    expect(languagesOf(s)).toEqual(["cpp"])
    expect(needsLanguage(s)).toBe(false)
    const t = new ProjectStore(false)
    startProject(t, "cpp")
    await openArchive(t, importZip(zipSync({ "notes.md": strToU8("# hi\n") })))
    expect(languagesOf(t)).toEqual(["python"])
    expect(needsLanguage(t)).toBe(false)
  })
})

describe("testPathOf", () => {
  const files = ["a/ivan/tri.py", "a/ivan/tri.test.py", "a/tri.test.py", "tri.test.py", "b/c/tri.py", "b/c/x.cpp", "x.test.py", "lib.hpp", "t.test.py", "README.md"]
  it("takes the nearest test file", () => {
    expect(testPathOf("a/ivan/tri.py", files)).toBe("a/ivan/tri.test.py")
    expect(testPathOf("a/ivan/tri.py", files.filter((f) => f !== "a/ivan/tri.test.py"))).toBe("a/tri.test.py")
  })
  it("goes up to the root", () => {
    expect(testPathOf("b/c/tri.py", files)).toBe("tri.test.py")
    expect(testPathOf("b/c/x.cpp", files)).toBe("x.test.py")
  })
  it("does not look in other folders", () => {
    expect(testPathOf("z/y.py", ["q/y.test.py"])).toBeNull()
  })
  it("gives null for tests, headers and other files", () => {
    expect(testPathOf("t.test.py", files)).toBeNull()
    expect(testPathOf("lib.hpp", ["lib.test.py"])).toBeNull()
    expect(testPathOf("README.md", ["README.test.py"])).toBeNull()
  })
})

describe("tournaments", () => {
  it("reset and replace clear the tournaments", () => {
    const s = new ProjectStore(false)
    tournamentsOf(s).set("a", { private: false })
    resetProject(s)
    expect(tournamentsOf(s).size).toBe(0)
    tournamentsOf(s).set("b", { private: true })
    replaceProject(s, { "x.py": "" })
    expect(tournamentsOf(s).size).toBe(0)
  })

  it("ensureTournament writes when absent or when the flag changes", () => {
    const s = new ProjectStore(false)
    ensureTournament(s, "a", false)
    expect(tournamentsOf(s).get("a")).toEqual({ private: false })
    ensureTournament(s, "a", true)
    expect(tournamentsOf(s).get("a")).toEqual({ private: true })
  })

  it("ensureTournament does not touch the map when nothing changes", () => {
    const s = new ProjectStore(false)
    ensureTournament(s, "a", true)
    let calls = 0
    tournamentsOf(s).observe(() => calls++)
    ensureTournament(s, "a", true)
    expect(calls).toBe(0)
    ensureTournament(s, "a", false)
    expect(calls).toBe(1)
  })
})
