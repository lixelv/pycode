import { describe, expect, it } from "vitest"

import { docAccess, fileAccess, parseEnv, renameRules, runVisible, serializeEnv, type Member, type Rules } from "./access"
import type { FileMeta } from "./store"

const meta = (id: string, extra: Partial<FileMeta> = {}): FileMeta => ({ id, kind: "text", size: 0, ...extra })

const rules = (over: Partial<Rules> = {}): Rules => ({
  files: {
    "main.py": meta("m"),
    "task.py": meta("t", { protected: true }),
    "task.test.py": meta("tt", { hidden: true }),
    "s/ivan/a.py": meta("i"),
    "s/a.py": meta("sa"),
    "s/x/a.py": meta("sx"),
  },
  folders: { "s/ivan": "ivan" },
  frozen: false,
  ...over,
})

const admin: Member = { role: "admin", level: "admin" }
const writer: Member = { role: "write", level: "write" }
const reader: Member = { role: "read", level: "read" }
const ivan: Member = { role: "ivan", level: "read" }
const petr: Member = { role: "petr", level: "write" }

describe("fileAccess", () => {
  it("lets admin write everything", () => {
    expect(fileAccess(admin, "task.test.py", rules())).toBe("write")
    expect(fileAccess(admin, "s/ivan/a.py", rules({ frozen: true }))).toBe("write")
  })

  it("hides hidden files from everyone else", () => {
    expect(fileAccess(writer, "task.test.py", rules())).toBe("none")
  })

  it("gives a role's own folder read-write, other roles nothing", () => {
    expect(fileAccess(ivan, "s/ivan/a.py", rules())).toBe("write")
    expect(fileAccess(petr, "s/ivan/a.py", rules())).toBe("none")
    expect(fileAccess(writer, "s/ivan/a.py", rules())).toBe("none")
  })

  it("needs access to every role folder on the path", () => {
    const r = rules({ folders: { s: "ivan", "s/x": "petr" } })
    expect(fileAccess(ivan, "s/x/a.py", r)).toBe("none")
    expect(fileAccess(petr, "s/x/a.py", r)).toBe("none")
    expect(fileAccess(ivan, "s/a.py", r)).toBe("write")
  })

  it("uses the base level for public files, at most read when protected", () => {
    expect(fileAccess(writer, "main.py", rules())).toBe("write")
    expect(fileAccess(reader, "main.py", rules())).toBe("read")
    expect(fileAccess(ivan, "main.py", rules())).toBe("read")
    expect(fileAccess(writer, "task.py", rules())).toBe("read")
  })

  it("keeps protected files read-only inside a role's own folder", () => {
    const r = rules()
    r.files["s/ivan/a.py"] = meta("i", { protected: true })
    expect(fileAccess(ivan, "s/ivan/a.py", r)).toBe("read")
  })

  it("freezes everyone but admins to read", () => {
    expect(fileAccess(writer, "main.py", rules({ frozen: true }))).toBe("read")
    expect(fileAccess(ivan, "s/ivan/a.py", rules({ frozen: true }))).toBe("read")
  })
})

describe("docAccess", () => {
  it("maps documents to access", () => {
    expect(docAccess(writer, "structure", rules())).toBe("read")
    expect(docAccess(admin, "structure", rules())).toBe("write")
    expect(docAccess(writer, "runtime", rules())).toBe("write")
    expect(docAccess(reader, "board", rules())).toBe("read")
    expect(docAccess(writer, "board", rules({ frozen: true }))).toBe("read")
    expect(docAccess(writer, "f:tt", rules())).toBe("none")
    expect(docAccess(ivan, "f:i", rules())).toBe("write")
    expect(docAccess(writer, "f:unknown", rules())).toBe("none")
  })
})

describe("renameRules", () => {
  it("moves folder roles with the folder", () => {
    expect(renameRules({ "s/ivan": "ivan", other: "x" }, "s", "t")).toEqual({ "t/ivan": "ivan", other: "x" })
  })
})

describe(".pycode.env", () => {
  it("round-trips, keeping spaces in paths", () => {
    const env = {
      roles: { ivan: "write" as const, olga: "read" as const },
      folders: { "students/ivan petrov": "ivan" },
      protected: ["task one.py"],
      hidden: ["task.test.py"],
    }
    expect(parseEnv(serializeEnv(env))).toEqual(env)
  })

  it("ignores comments and unknown lines", () => {
    expect(parseEnv("# hi\n\nwhatever x\nprotected a.py\n")).toEqual({ roles: {}, folders: {}, protected: ["a.py"], hidden: [] })
  })
})

describe("runVisible", () => {
  it("gives a run public files and its own role folders, never hidden ones", () => {
    const r = rules()
    expect(runVisible("main.py", "main.py", r)).toBe(true)
    expect(runVisible("main.py", "task.test.py", r)).toBe(false)
    expect(runVisible("main.py", "s/ivan/a.py", r)).toBe(false)
    expect(runVisible("s/ivan/a.py", "s/ivan/a.py", r)).toBe(true)
    expect(runVisible("s/ivan/a.py", "main.py", r)).toBe(true)
    expect(runVisible("s/ivan/a.py", "s/x/a.py", rules({ folders: { "s/ivan": "ivan", "s/x": "petr" } }))).toBe(false)
  })
})
