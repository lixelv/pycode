import { describe, expect, it } from "vitest"
import * as Y from "yjs"

import type { CheckResult } from "@/workers/protocol"
import type { Member, Rules } from "./project/access"
import type { FileMeta } from "./project/store"
import { allPassed, entryOf, readableTournaments, tableName, mayRecord, recordCheck, recordRun, resultsOf, standings, taskOf, type TournamentEntry } from "./tournament"

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

describe("entryOf and an error of the test file", () => {
  it("makes no entry: the file's one line has no points", () => {
    expect(entryOf([{ name: "tests", ok: false, message: "points(amount): amount is a positive number" }], "Ann", 7)).toBeNull()
  })
})

describe("recordCheck", () => {
  const meta = (id: string, extra: Partial<FileMeta> = {}): FileMeta => ({ id, kind: "text", size: 0, ...extra })
  const rules = (files: Record<string, FileMeta>, extra: Partial<Rules> = {}): Rules => ({
    files,
    folders: { "s/ivan": "ivan", "s/petr": "petr" },
    frozen: false,
    tournaments: {},
    ...extra,
  })
  // Hidden tests at the root, a solution in each student's own folder.
  const base = rules({
    "s/ivan/tri.py": meta("a"),
    "s/petr/tri.py": meta("b"),
    "tri.test.py": meta("t", { hidden: true }),
    "s/lab.test.py": meta("l", { hidden: true }),
  })
  const ivan: Member = { level: "read", roles: ["ivan"] }
  const who = { userId: "u1", name: "Ivan" }
  const results = [r("test_a", true, 10), r("test_b", false, 30)]

  it("records a student's run under userId/task and says it was recorded", () => {
    const doc = new Y.Doc()
    expect(recordCheck(doc, results, "s/ivan/tri.py", "tri.test.py", who, ivan, base, 5)).toBe(false)
    expect(resultsOf(doc).toJSON()).toEqual({ "u1/tri": { name: "Ivan", score: 10, max: 40, passed: ["test_a"], at: 5 } })
  })

  it("takes the task from the test file, wherever it lies", () => {
    const doc = new Y.Doc()
    expect(recordCheck(doc, results, "s/ivan/tri.py", "s/lab.test.py", who, ivan, base, 5)).toBe(false)
    expect(Object.keys(resultsOf(doc).toJSON())).toEqual(["u1/lab"])
  })

  it("refuses a member who has no access to the solution", () => {
    const doc = new Y.Doc()
    const petr: Member = { level: "read", roles: ["petr"] }
    expect(recordCheck(doc, results, "s/ivan/tri.py", "tri.test.py", who, petr, base, 5)).toBe(true)
    const writer: Member = { level: "write", roles: [] } // a public-files writer without the folder's role
    expect(recordCheck(doc, results, "s/ivan/tri.py", "tri.test.py", who, writer, base, 5)).toBe(true)
    expect(resultsOf(doc).size).toBe(0)
  })

  it("refuses a solution the member may read but not change", () => {
    const doc = new Y.Doc()
    const frozen = { ...base, frozen: true }
    expect(recordCheck(doc, results, "s/ivan/tri.py", "tri.test.py", who, ivan, frozen, 5)).toBe(true)
    expect(resultsOf(doc).size).toBe(0)
  })

  it("refuses a member who can change the test", () => {
    const doc = new Y.Doc()
    const open = rules({ "s/ivan/tri.py": meta("a"), "tri.test.py": meta("t") }) // a public test
    const writer: Member = { level: "write", roles: ["ivan"] }
    expect(recordCheck(doc, results, "s/ivan/tri.py", "tri.test.py", who, writer, open, 5)).toBe(true)
    const inside = rules({ "s/ivan/tri.py": meta("a"), "s/ivan/tri.test.py": meta("t") })
    expect(recordCheck(doc, results, "s/ivan/tri.py", "s/ivan/tri.test.py", who, ivan, inside, 5)).toBe(true)
    const admin: Member = { level: "admin", roles: [] }
    expect(recordCheck(doc, results, "s/ivan/tri.py", "tri.test.py", who, admin, base, 5)).toBe(true)
    expect(resultsOf(doc).size).toBe(0)
  })

  it("records without a session whatever the rules say", () => {
    const doc = new Y.Doc()
    const nothing = rules({ "s/ivan/tri.py": meta("a", { protected: true }), "tri.test.py": meta("t") }, { frozen: true })
    expect(recordCheck(doc, results, "s/ivan/tri.py", "tri.test.py", who, null, nothing, 5)).toBe(false)
    expect(resultsOf(doc).get("u1/tri")).toEqual({ name: "Ivan", score: 10, max: 40, passed: ["test_a"], at: 5 })
  })

  it("records nothing for a file without tests", () => {
    const doc = new Y.Doc()
    expect(recordCheck(doc, [], "s/ivan/tri.py", "tri.test.py", who, ivan, base, 5)).toBe(false)
    expect(recordCheck(doc, [], "s/ivan/tri.py", "tri.test.py", who, null, base, 5)).toBe(false)
    expect(resultsOf(doc).size).toBe(0)
  })

  it("keeps the first run when a later one is worse, and says it was not refused", () => {
    const doc = new Y.Doc()
    const good = [r("test_a", true, 10), r("test_b", true, 30)]
    expect(recordCheck(doc, good, "s/ivan/tri.py", "tri.test.py", who, ivan, base, 5)).toBe(false)
    expect(recordCheck(doc, results, "s/ivan/tri.py", "tri.test.py", who, ivan, base, 9)).toBe(false)
    expect(recordCheck(doc, good, "s/ivan/tri.py", "tri.test.py", who, ivan, base, 12)).toBe(false) // equal: `at` stays
    expect(resultsOf(doc).get("u1/tri")).toEqual({ name: "Ivan", score: 40, max: 40, passed: ["test_a", "test_b"], at: 5 })
  })
})

describe("mayRecord and paths that are not files", () => {
  const rules: Rules = {
    files: { "tri.py": { id: "a", kind: "text", size: 0, protected: true }, "tri.test.py": { id: "t", kind: "text", size: 0, hidden: true } },
    folders: {},
    frozen: false,
    tournaments: {},
  }
  const writer: Member = { level: "write", roles: [] }

  it("does not take another spelling of a protected file for a free one", () => {
    expect(mayRecord(writer, "./tri.py", "tri.test.py", rules)).toBe(false)
  })

  it("refuses a solution or a test that does not exist", () => {
    expect(mayRecord(writer, "nothing.py", "tri.test.py", rules)).toBe(false)
    const open: Rules = { ...rules, files: { ...rules.files, "free.py": { id: "f", kind: "text", size: 0 } } }
    expect(mayRecord(writer, "free.py", "tri.test.py", open)).toBe(true)
    expect(mayRecord(writer, "free.py", "no.test.py", open)).toBe(false)
  })
})

describe("tableName", () => {
  it("keeps a plain name", () => {
    expect(tableName("Ann", "fallback")).toBe("Ann")
  })
  it("cuts a long one", () => {
    expect(tableName("x".repeat(5000), "fallback")).toBe("x".repeat(40))
  })
  it("replaces what is not a name", () => {
    for (const bad of [undefined, null, 5, { a: 1 }, ["x"], "", "   "]) expect(tableName(bad, "fallback")).toBe("fallback")
  })
})

describe("allPassed", () => {
  const line = (ok: boolean, points?: number): CheckResult => ({ name: "t", ok, message: "", ...(points !== undefined && { points }) })
  it("is true only when every line passed", () => {
    expect(allPassed([line(true, 10), line(true)])).toBe(true)
    expect(allPassed([line(true, 10), line(false, 0)])).toBe(false)
  })
  it("is false for no lines at all", () => {
    expect(allPassed([])).toBe(false)
  })
})

describe("readableTournaments", () => {
  const rules = (tournaments: Rules["tournaments"]): Rules => ({ files: {}, folders: {}, frozen: false, tournaments })
  const student: Member = { level: "write", roles: [] }
  const admin: Member = { level: "admin", roles: [] }
  const all = () => true

  it("gives the tables a member may read, sorted", () => {
    const r = rules({ b: { private: false }, a: { private: false }, c: { private: true } })
    expect(readableTournaments(student, r, all)).toEqual(["a", "b"])
    expect(readableTournaments(admin, r, all)).toEqual(["a", "b", "c"])
  })
  it("leaves out a table this store has not opened: rules can be a moment behind the store", () => {
    expect(readableTournaments(student, rules({ a: { private: false }, b: { private: false } }), (id) => id === "t:b")).toEqual(["b"])
  })
  it("keeps an id with a line break whole", () => {
    expect(readableTournaments(student, rules({ "a\nb": { private: false } }), all)).toEqual(["a\nb"])
  })
})

