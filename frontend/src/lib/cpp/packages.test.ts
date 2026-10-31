import { afterEach, describe, expect, it, vi } from "vitest"
import { applyLoadFailures, fetchCppPackage, headerFiles, installCppPackage, loadCppPackages, parseCppSpec, pickInclude, type CppPackage } from "./packages"

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
  it("rejects . and .. as owner or repo", () => {
    for (const bad of ["../..", "./x", "x/..", "../x@v1", "./."]) expect(parseCppSpec(bad)).toBeNull()
    expect(parseCppSpec("a.b/c..d")).toMatchObject({ repo: "a.b/c..d" })
  })
  it("rejects a ref with a . or .. path segment", () => {
    for (const bad of ["o/r@../x", "o/r@a/../b", "o/r@.", "o/r@..", "o/r@./x", "o/r@a/."]) expect(parseCppSpec(bad)).toBeNull()
  })
  it("accepts refs with dots and slashes that are not path segments", () => {
    expect(parseCppSpec("o/r@v1.2.3")).toMatchObject({ repo: "o/r", ref: "v1.2.3" })
    expect(parseCppSpec("o/r@feature/x")).toMatchObject({ repo: "o/r", ref: "feature/x" })
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

describe("loadCppPackages", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("leaves out a package that fails to load and reports it, but loads the others", async () => {
    const ok = (repo: string): CppPackage => ({ repo, ref: "1.0.0", spec: `${repo}@1.0.0`, status: "installed", version: "1.0.0" })
    const onFail = vi.fn()
    stub({
      "https://data.jsdelivr.com/v1/packages/gh/ok/lib@1.0.0?structure=flat": json({ files: [{ name: "/include/a.hpp", size: 4 }] }),
      "https://cdn.jsdelivr.net/gh/ok/lib@1.0.0/include/a.hpp": () => new Response("// a", { status: 200 }),
      "https://data.jsdelivr.com/v1/packages/gh/bad/lib@1.0.0?structure=flat": () => new Response("", { status: 503 }),
    })
    const list: CppPackage[] = [ok("ok/lib"), ok("bad/lib"), { ...ok("err/lib"), status: "error" }]
    const result = await loadCppPackages(list, onFail)
    expect(result.files).toEqual({ "/packages/ok/lib/include/a.hpp": "// a" })
    expect(result.includes).toEqual(["/packages/ok/lib/include"])
    expect(onFail).toHaveBeenCalledTimes(1)
    expect(onFail).toHaveBeenCalledWith("bad/lib", "1.0.0", expect.stringContaining("503"))
  })

  it("does not report an old rejection once a newer load holds that package", async () => {
    const pkg = (repo: string): CppPackage => ({ repo, ref: "1.0.0", spec: `${repo}@1.0.0`, status: "installed", version: "1.0.0" })
    const listing = (name: string) => json({ files: [{ name, size: 4 }] })
    let failFirst!: () => void
    stub({
      "https://data.jsdelivr.com/v1/packages/gh/late/lib@1.0.0?structure=flat": () =>
        new Promise<Response>((resolve) => {
          failFirst = () => resolve(new Response("", { status: 503 }))
        }) as unknown as Response,
    })
    const onFail = vi.fn()
    const old = loadCppPackages([pkg("late/lib")], onFail)
    await vi.waitFor(() => expect(failFirst).toBeDefined())
    stub({
      "https://data.jsdelivr.com/v1/packages/gh/late/lib@1.0.0?structure=flat": listing("/include/a.hpp"),
      "https://cdn.jsdelivr.net/gh/late/lib@1.0.0/include/a.hpp": () => new Response("// a", { status: 200 }),
    })
    await installCppPackage("late/lib", "1.0.0")
    failFirst()
    await old
    expect(onFail).not.toHaveBeenCalled()
  })
})

describe("applyLoadFailures", () => {
  const pkg = (over: Partial<CppPackage>): CppPackage => ({
    repo: "o/r",
    ref: "1.0.0",
    spec: "o/r@1.0.0",
    status: "installed",
    version: "1.0.0",
    ...over,
  })

  it("turns an installed entry with a matching repo@version key into a load-failed error", () => {
    const [p] = applyLoadFailures([pkg({})], { "o/r@1.0.0": "boom" })
    expect(p).toMatchObject({ status: "error", error: "boom", loadFailed: true })
  })
  it("leaves the same repo at another version untouched", () => {
    const stored = pkg({ version: "2.0.0" })
    const [p] = applyLoadFailures([stored], { "o/r@1.0.0": "boom" })
    expect(p).toBe(stored)
    expect(p.loadFailed).toBeUndefined()
  })
  it("leaves a stored error or installing entry untouched and not flagged", () => {
    const err = pkg({ status: "error", error: "stored" })
    const inst = pkg({ repo: "a/b", status: "installing" })
    const [e, i] = applyLoadFailures([err, inst], { "o/r@1.0.0": "boom", "a/b@1.0.0": "boom" })
    expect(e).toBe(err)
    expect(i).toBe(inst)
    expect(e.error).toBe("stored")
    expect(e.loadFailed).toBeUndefined()
    expect(i.loadFailed).toBeUndefined()
  })
  it("returns the entries unchanged when nothing failed", () => {
    const list = [pkg({}), pkg({ repo: "a/b" })]
    const out = applyLoadFailures(list, {})
    expect(out).toEqual(list)
    expect(out[0]).toBe(list[0])
    expect(out[1]).toBe(list[1])
  })
  it("does not mutate the stored entry", () => {
    const stored = pkg({})
    applyLoadFailures([stored], { "o/r@1.0.0": "boom" })
    expect(stored.status).toBe("installed")
    expect(stored.loadFailed).toBeUndefined()
  })
})
