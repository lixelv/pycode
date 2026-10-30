import { describe, expect, it } from "vitest"

import { parseClangDiagnostics, type ClangDiagnostic } from "./diagnostics"

describe("parseClangDiagnostics", () => {
  it("parses an error line for the entry", () => {
    const log = "main.cpp:3:5: error: expected ';' after expression"
    expect(parseClangDiagnostics(log, "main.cpp")).toEqual<ClangDiagnostic[]>([
      { line: 3, col: 5, severity: "error", message: "expected ';' after expression" },
    ])
  })

  it("recognizes warnings", () => {
    const log = "main.cpp:7:2: warning: unused variable 'y'"
    expect(parseClangDiagnostics(log, "main.cpp")).toEqual<ClangDiagnostic[]>([
      { line: 7, col: 2, severity: "warning", message: "unused variable 'y'" },
    ])
  })

  it("drops notes", () => {
    const log = "main.cpp:3:5: note: previous declaration is here"
    expect(parseClangDiagnostics(log, "main.cpp")).toEqual([])
  })

  it("maps an error in an included header to the include line of the entry", () => {
    const log = "In file included from main.cpp:2:\n./lib.h:4:1: error: unknown type name 'foo'"
    expect(parseClangDiagnostics(log, "main.cpp")).toEqual<ClangDiagnostic[]>([
      { line: 2, col: 1, severity: "error", message: "lib.h:4: unknown type name 'foo'" },
    ])
  })

  it("ignores errors in other files that are not included from the entry", () => {
    const log = "other.cpp:1:1: error: boom"
    expect(parseClangDiagnostics(log, "main.cpp")).toEqual([])
  })

  it("matches entries inside a folder", () => {
    const log = "src/a.cpp:2:1: error: x"
    expect(parseClangDiagnostics(log, "src/a.cpp")).toEqual<ClangDiagnostic[]>([
      { line: 2, col: 1, severity: "error", message: "x" },
    ])
  })

  it("ignores source excerpts, carets and summary lines in a real clang log", () => {
    const log = [
      "main.cpp:3:5: error: expected ';' after expression",
      "    3 |   x",
      "      |   ^",
      "main.cpp:7:2: warning: unused variable 'y'",
      "    7 |   int y;",
      "      |   ^~~~~",
      "1 error and 1 warning generated.",
    ].join("\n")
    expect(parseClangDiagnostics(log, "main.cpp")).toEqual<ClangDiagnostic[]>([
      { line: 3, col: 5, severity: "error", message: "expected ';' after expression" },
      { line: 7, col: 2, severity: "warning", message: "unused variable 'y'" },
    ])
  })
})
