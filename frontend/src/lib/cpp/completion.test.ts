import { describe, expect, it } from "vitest"

import { byteColumn, parseCompletions, splitPreamble, wantsCompletion } from "./completion"

describe("parseCompletions", () => {
  it("reads a method with its parameters and return type", () => {
    const [c] = parseCompletions("COMPLETION: push_back : [#void#]push_back(<#const_reference x#>)\n")
    expect(c).toEqual({ name: "push_back", kind: "function", detail: "void push_back(const_reference x)", snippet: "push_back(${1:const_reference x})", overloads: 0 })
  })

  it("treats a call with no parameters and a const method", () => {
    const [c] = parseCompletions("COMPLETION: size : [#size_type#]size()[# const#]\n")
    expect(c.detail).toBe("size_type size() const")
    expect(c.snippet).toBe("size()$0")
  })

  it("merges overloads: the cursor goes inside the brackets", () => {
    const list = parseCompletions("COMPLETION: at : [#reference#]at(<#size_type n#>)\nCOMPLETION: at : [#const_reference#]at(<#size_type n#>)[# const#]\n")
    expect(list).toHaveLength(1)
    expect(list[0].overloads).toBe(1)
    expect(list[0].snippet).toBe("at($0)")
  })

  it("reads variables, types and plain keywords", () => {
    const list = parseCompletions("COMPLETION: count : [#int#]count\nCOMPLETION: vector : vector<<#class T#>>\nCOMPLETION: while\n")
    expect(list.map((c) => [c.name, c.kind])).toEqual([["count", "variable"], ["vector", "type"], ["while", "keyword"]])
    expect(list[0].detail).toBe("int count")
    expect(list[1].snippet).toBe("vector")
  })

  it("marks optional parameters without inserting them", () => {
    const [c] = parseCompletions("COMPLETION: f : [#void#]f(<#int a#>{#, <#int b#>#})\n")
    expect(c.detail).toBe("void f(int a, int b)")
    expect(c.snippet).toBe("f(${1:int a})")
  })

  it("skips internals, operators, destructors, hidden names, patterns and other log lines", () => {
    const log = "COMPLETION: __x : [#int#]__x\nCOMPLETION: operator= : [#T &#]operator=(<#T#>)\nCOMPLETION: ~A : ~A()\nCOMPLETION: g (Hidden) : [#int#]g\nCOMPLETION: Pattern : for(<#a#>)\nOVERLOAD: [#void#]f()\nmain.cpp:1:1: error: x\n"
    expect(parseCompletions(log)).toEqual([])
  })
})

describe("splitPreamble", () => {
  it("takes leading system includes, comments and blanks, keeping line numbers", () => {
    const { preamble, body } = splitPreamble("// hi\n#include <vector>\n\n#include <map>\nint x;\n")
    expect(preamble).toBe("#include <vector>\n#include <map>\n")
    expect(body).toBe("\n\n\n\nint x;\n")
  })

  it("stops at a project include: it may change at any time", () => {
    const { preamble, body } = splitPreamble('#include <vector>\n#include "a.h"\n#include <map>\n')
    expect(preamble).toBe("#include <vector>\n")
    expect(body).toBe('\n#include "a.h"\n#include <map>\n')
  })

  it("stops at a block comment or a macro, which could change what follows", () => {
    expect(splitPreamble("#define N 1\n#include <map>\n").preamble).toBe("")
    expect(splitPreamble("/* a\n#include <map>\n*/\n").preamble).toBe("")
  })

  it("leaves an include the cursor is still typing on a last line out", () => {
    expect(splitPreamble("#include <vector>\n#include <ma").preamble).toBe("#include <vector>\n")
  })
})

describe("byteColumn", () => {
  it("counts UTF-8 bytes, 1-based", () => {
    expect(byteColumn("  v.", 5)).toBe(5)
    expect(byteColumn('"я"; v.', 8)).toBe(9)
  })
})

describe("wantsCompletion", () => {
  it("asks after a member access and in ordinary code", () => {
    for (const [line, trigger] of [["v.", "."], ["p->", ">"], ["std::", ":"], ["  in", undefined], ['cout << "a" << v.', "."]] as const) expect(wantsCompletion(line, trigger)).toBe(true)
  })

  it("stays quiet on a lone > or :, in comments, strings and preprocessor lines", () => {
    for (const [line, trigger] of [["a >", ">"], ["x ? y :", ":"], ["// v.", "."], ['"v.', "."], ["#include <v", undefined]] as const) expect(wantsCompletion(line, trigger)).toBe(false)
  })
})
