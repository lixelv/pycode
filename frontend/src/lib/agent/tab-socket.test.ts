import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { CollabProvider } from "@/lib/collab/provider"
import { createFile } from "@/lib/project/project"
import { ProjectStore } from "@/lib/project/store"

import type { AgentApp, AgentContext } from "./tools"

vi.mock("@/lib/collab/provider", () => ({ addRole: vi.fn(), listCodes: vi.fn() }))
vi.mock("@/hooks/use-packages", () => ({ parseSpec: vi.fn() }))

const KEY_CANDIDATES = (s: Map<string, string>) => [...s.entries()]

/** One browser tab's sessionStorage. A duplicated tab starts with a copy. */
function storage(from?: Map<string, string>) {
  const map = new Map(from ?? [])
  return {
    map,
    api: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size
      },
    },
  }
}

/** A page load: its own module state and its own sessionStorage, the channel shared as in one browser. */
async function pageLoad(session: ReturnType<typeof storage>) {
  vi.resetModules()
  vi.stubGlobal("sessionStorage", session.api)
  const { resolveTabId } = await import("./tab-socket")
  return resolveTabId()
}

describe("resolveTabId", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("gives a fresh tab a new id and keeps it in sessionStorage", async () => {
    const session = storage()
    const id = await pageLoad(session)
    expect(id).toMatch(/\S{8,}/)
    expect(KEY_CANDIDATES(session.map).some(([, value]) => value === id)).toBe(true)
  })

  it("two fresh tabs get different ids", async () => {
    const a = await pageLoad(storage())
    const b = await pageLoad(storage())
    expect(a).not.toBe(b)
  })

  it("keeps the id across a reload: nobody on the channel answers for it", async () => {
    // The first page's listener is still alive in this process, so the stored
    // value is swapped for an id no page here holds: what a reload sees.
    const session = storage()
    const first = await pageLoad(session)
    const reloaded = storage(session.map)
    const stored = KEY_CANDIDATES(session.map).find(([, value]) => value === first)!
    reloaded.api.setItem(stored[0], "tab-from-before-the-reload")
    const again = await pageLoad(reloaded)
    expect(again).toBe("tab-from-before-the-reload")
  })

  // Review focus 4.
  it("a duplicate gets a new id, and the original keeps its own", async () => {
    const original = storage()
    const id = await pageLoad(original)
    const duplicate = storage(original.map) // the browser copies sessionStorage
    const dupId = await pageLoad(duplicate)
    expect(dupId).not.toBe(id)
    // The duplicate stored its new id, the original was not touched.
    expect(KEY_CANDIDATES(duplicate.map).some(([, value]) => value === dupId)).toBe(true)
    expect(KEY_CANDIDATES(duplicate.map).some(([, value]) => value === id)).toBe(false)
    expect(KEY_CANDIDATES(original.map).some(([, value]) => value === id)).toBe(true)
  })

  it("a second duplicate is told apart from both", async () => {
    const original = storage()
    const a = await pageLoad(original)
    const b = await pageLoad(storage(original.map))
    const c = await pageLoad(storage(original.map))
    expect(new Set([a, b, c]).size).toBe(3)
  })
})

describe("what a tab does with the socket's messages", () => {
  let ctx: AgentContext

  beforeEach(() => {
    const store = new ProjectStore(false)
    createFile(store, "main.py", "print(1)")
    ctx = { store, provider: { isOwner: true } as CollabProvider, app: { moved: vi.fn(), open: vi.fn(), active: () => "main.py" } as unknown as AgentApp }
  })

  it("runs a call of its own project and answers with its id", async () => {
    const { executeCall } = await import("./tab-socket")
    const answer = await executeCall({ type: "call", id: 7, name: "read_file", args: { path: "main.py" }, project: "p1" }, "p1", ctx)
    expect(answer.type).toBe("result")
    expect(answer.id).toBe(7)
    expect(answer.data.isError).toBeFalsy()
    expect(JSON.stringify(answer.data.content)).toContain("print(1)")
  })

  it("refuses a call for another project and does not run it", async () => {
    const { executeCall } = await import("./tab-socket")
    const answer = await executeCall({ type: "call", id: 8, name: "write_file", args: { path: "main.py", content: "boom" }, project: "other" }, "p1", ctx)
    expect(answer.id).toBe(8)
    expect(answer.data.isError).toBe(true)
    const { textOf } = await import("@/lib/project/project")
    expect(textOf(ctx.store, "main.py")!.toString()).toBe("print(1)")
  })

  it("refuses a call when it has no project", async () => {
    const { executeCall } = await import("./tab-socket")
    const answer = await executeCall({ type: "call", id: 9, name: "read_file", args: { path: "main.py" }, project: "p1" }, null, ctx)
    expect(answer.data.isError).toBe(true)
  })

  it("open saves first, then navigates", async () => {
    const { handleOpen } = await import("./tab-socket")
    const order: string[] = []
    const reply = await handleOpen("p2", {
      flush: async () => void order.push("flush"),
      navigate: (project) => void order.push(`navigate ${project}`),
    })
    expect(order).toEqual(["flush", "navigate p2"])
    expect(reply).toBeNull()
  })

  it("open stays put and reports when saving fails", async () => {
    const { handleOpen } = await import("./tab-socket")
    const navigate = vi.fn()
    const reply = await handleOpen("p2", {
      flush: async () => {
        throw new Error("no network")
      },
      navigate,
    })
    expect(navigate).not.toHaveBeenCalled()
    expect(reply).toEqual({ type: "open-failed", error: expect.stringContaining("no network") })
  })
})
