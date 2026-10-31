import { describe, expect, it } from "vitest"
import * as Y from "yjs"

import type { CheckResult } from "@/workers/protocol"
import type { Member, Rules } from "./project/access"
import type { FileMeta } from "./project/store"
import { entryOf, mayRecord, recordRun, resultsOf, standings, taskOf, type TournamentEntry } from "./tournament"

const r = (name: string, ok: boolean, points = 0, skipped = false): CheckResult => ({ name, ok, message: "", points, ...(skipped && { skipped }) })

describe("entryOf", () => {
  it("sums the points of passed tests", () => {
    expect(entryOf([r("a", true, 10), r("b", false, 30), r("c", false, 5, true)], "Ann", 7)).toEqual({ name: "Ann", score: 10, max: 45, passed: ["a"], at: 7 })
  })

  it("makes no entry for a file without tests", () => {
    expect(entryOf([], "Ann", 7)).toBeNull()
  })
})

describe("taskOf", () => {
  it("takes the task from the test file's name", () => {
    expect(taskOf("a/ivan/tri.test.py")).toBe("tri")
    expect(taskOf("tri.test.py")).toBe("tri")
  })
})

describe("recordRun", () => {
  it("replaces an entry only by a strictly better score", () => {
    const doc = new Y.Doc()
    const entry = (score: number, at: number): TournamentEntry => ({ name: "A", score, max: 40, passed: [], at })
    expect(recordRun(doc, "u", "tri", entry(10, 1))).toBe(true)
    expect(recordRun(doc, "u", "tri", entry(10, 2))).toBe(false)
    expect(recordRun(doc, "u", "tri", entry(5, 3))).toBe(false)
    expect(resultsOf(doc).get("u/tri")!.at).toBe(1)
    expect(recordRun(doc, "u", "tri", entry(20, 4))).toBe(true)
  })

  it("records a first zero score", () => {
    const doc = new Y.Doc()
    expect(recordRun(doc, "u", "tri", { name: "A", score: 0, max: 10, passed: [], at: 1 })).toBe(true)
  })
})

describe("standings", () => {
  it("ranks by sum, then by who reached it earlier", () => {
    const e = (name: string, score: number, at: number): TournamentEntry => ({ name, score, max: 50, passed: [], at })
    const list = standings({ "a/x": e("A", 10, 5), "a/y": e("A", 10, 9), "b/x": e("B", 20, 3), "c/x": e("C", 5, 1) })
    expect(list.map((s) => [s.name, s.total, s.place])).toEqual([["B", 20, 1], ["A", 20, 2], ["C", 5, 3]])
    expect(list[1].scores).toEqual({ x: 10, y: 10 })
  })
})

describe("mayRecord", () => {
  it("records only a solution the student writes and a test they do not", () => {
    const meta = (id: string, extra: Partial<FileMeta> = {}): FileMeta => ({ id, kind: "text", size: 0, ...extra })
    const rules = (solution: Partial<FileMeta> = {}, test: Partial<FileMeta> = { hidden: true }): Rules => ({
      files: { "s/ivan/a.py": meta("a", solution), "s/a.test.py": meta("t", test) },
      folders: { "s/ivan": "ivan" },
      frozen: false,
      tournaments: {},
    })
    const ivan: Member = { level: "read", roles: ["ivan"] }
    expect(mayRecord(ivan, "s/ivan/a.py", "s/a.test.py", rules())).toBe(true)
    expect(mayRecord({ level: "write", roles: [] }, "s/ivan/a.py", "s/a.test.py", rules())).toBe(false) // someone else's folder
    expect(mayRecord(ivan, "s/ivan/a.py", "s/a.test.py", rules({ protected: true }))).toBe(false)
    const insideOwnFolder: Rules = { ...rules(), files: { "s/ivan/a.py": meta("a"), "s/ivan/a.test.py": meta("t") } }
    expect(mayRecord(ivan, "s/ivan/a.py", "s/ivan/a.test.py", insideOwnFolder)).toBe(false) // can change the test
  })
})
