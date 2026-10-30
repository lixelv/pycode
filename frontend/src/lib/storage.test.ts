import { describe, expect, it } from "vitest"
import { renameLocalKeys, withTimeout } from "./storage"

// A Map-backed stand-in for localStorage.
function fakeStorage(initial: Record<string, string>) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

describe("renameLocalKeys", () => {
  it("moves pycode:* to polycode:*", () => {
    const s = fakeStorage({ "pycode:md-mode": "split" })
    renameLocalKeys(s)
    expect(s.getItem("polycode:md-mode")).toBe("split")
    expect(s.getItem("pycode:md-mode")).toBeNull()
  })

  it("keeps an existing new key and drops the old one", () => {
    const s = fakeStorage({ "polycode:x": "new", "pycode:x": "old" })
    renameLocalKeys(s)
    expect(s.getItem("polycode:x")).toBe("new")
    expect(s.getItem("pycode:x")).toBeNull()
  })

  it("moves python-coder:theme and leaves python-coder:code alone", () => {
    const s = fakeStorage({ "python-coder:theme": "dark", "python-coder:code": "print(1)" })
    renameLocalKeys(s)
    expect(s.getItem("polycode:theme")).toBe("dark")
    expect(s.getItem("python-coder:theme")).toBeNull()
    expect(s.getItem("python-coder:code")).toBe("print(1)")
  })

  it("moves other python-coder:* keys but not python-coder:packages", () => {
    const s = fakeStorage({
      "python-coder:lang": "ru",
      "python-coder:files-width": "300",
      "python-coder:packages": "[]",
    })
    renameLocalKeys(s)
    expect(s.getItem("polycode:lang")).toBe("ru")
    expect(s.getItem("polycode:files-width")).toBe("300")
    expect(s.getItem("python-coder:lang")).toBeNull()
    expect(s.getItem("python-coder:files-width")).toBeNull()
    expect(s.getItem("python-coder:packages")).toBe("[]")
    expect(s.getItem("polycode:packages")).toBeNull()
  })

  it("keeps an existing new key over a python-coder:* one", () => {
    const s = fakeStorage({ "polycode:lang": "en", "python-coder:lang": "ru" })
    renameLocalKeys(s)
    expect(s.getItem("polycode:lang")).toBe("en")
    expect(s.getItem("python-coder:lang")).toBeNull()
  })
})

describe("withTimeout", () => {
  it("returns the result when the promise is quick", async () => {
    expect(await withTimeout(Promise.resolve(5), 1000)).toBe(5)
  })

  it("gives up on a promise that never settles", async () => {
    expect(await withTimeout(new Promise(() => {}), 20)).toBeUndefined()
  })
})
