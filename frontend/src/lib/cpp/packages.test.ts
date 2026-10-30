import { afterEach, describe, expect, it, vi } from "vitest"
import { fetchCppPackage, headerFiles, parseCppSpec, pickInclude } from "./packages"

describe("parseCppSpec", () => {
  it("parses owner/repo@ref", () => {
    expect(parseCppSpec("nlohmann/json@v3.11.3")).toEqual({
      repo: "nlohmann/json",
      ref: "v3.11.3",
      spec: "nlohmann/json@v3.11.3",
    })
  })
  it("parses owner/repo without a ref", () => {
    expect(parseCppSpec("nlohmann/json")).toMatchObject({ repo: "nlohmann/json", ref: null })
  })
  it("rejects a bare name", () => {
    expect(parseCppSpec("json")).toBeNull()
  })
})

describe("pickInclude", () => {
  it("prefers include", () => {
    expect(pickInclude(["include/nlohmann/json.hpp", "README.md"])).toBe("include")
  })
  it("falls back to single_include", () => {
    expect(pickInclude(["single_include/a.hpp"])).toBe("single_include")
  })
  it("falls back to the root", () => {
    expect(pickInclude(["a.h"])).toBe("")
  })
})

describe("headerFiles", () => {
  it("keeps headers and extensionless files inside the include path", () => {
    expect(
      headerFiles(["include/Eigen/Dense", "include/x.cpp", "include/a.hpp", "docs/a.h"], "include"),
    ).toEqual(["include/Eigen/Dense", "include/a.hpp"])
  })
})

const RESOLVED = "https://data.jsdelivr.com/v1/packages/gh/foo/bar/resolved"
const LIST = "https://data.jsdelivr.com/v1/packages/gh/foo/bar@1.0.0?structure=flat"
const FILE = (p: string) => `https://cdn.jsdelivr.net/gh/foo/bar@1.0.0/${p}`

function stub(routes: Record<string, () => Response>) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const r = routes[url]
    return r ? r() : new Response("nope", { status: 404 })
  })
  vi.stubGlobal("fetch", fn)
  return fn
}
const json = (v: unknown) => () => new Response(JSON.stringify(v), { status: 200 })

describe("fetchCppPackage", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("rejects with 'not found' when resolve returns 404", async () => {
    stub({ [RESOLVED]: () => new Response("", { status: 404 }) })
    await expect(fetchCppPackage("foo/bar", null)).rejects.toThrow(/not found/)
  })

  it("rejects with 'no headers' when the list has none", async () => {
    stub({
      [RESOLVED]: json({ version: "1.0.0" }),
      [LIST]: json({ files: [{ name: "/README.md", size: 5 }, { name: "/src/a.cpp", size: 7 }] }),
    })
    await expect(fetchCppPackage("foo/bar", null)).rejects.toThrow(/no headers/)
  })

  it("downloads headers inside the include path", async () => {
    const fn = stub({
      [RESOLVED]: json({ version: "1.0.0" }),
      [LIST]: json({
        files: [
          { name: "/include/x/a.hpp", size: 10 },
          { name: "/README.md", size: 5 },
        ],
      }),
      [FILE("include/x/a.hpp")]: () => new Response("// a", { status: 200 }),
    })
    await expect(fetchCppPackage("foo/bar", null)).resolves.toEqual({
      version: "1.0.0",
      include: "include",
      files: { "include/x/a.hpp": "// a" },
    })
    expect(fn.mock.calls.map(c => String(c[0]))).not.toContain(FILE("README.md"))
  })

  it("rejects 'too large' before fetching any file", async () => {
    const fn = stub({
      [RESOLVED]: json({ version: "1.0.0" }),
      [LIST]: json({
        files: [
          { name: "/include/a.hpp", size: 20 * 1024 * 1024 },
          { name: "/include/b.hpp", size: 20 * 1024 * 1024 },
        ],
      }),
    })
    await expect(fetchCppPackage("foo/bar", null)).rejects.toThrow(/too large/)
    const urls = fn.mock.calls.map(c => String(c[0]))
    expect(urls.some(u => u.startsWith("https://cdn.jsdelivr.net/"))).toBe(false)
  })
})
