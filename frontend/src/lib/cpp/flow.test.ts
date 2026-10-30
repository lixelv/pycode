import { describe, expect, it } from "vitest"

import { categorize } from "@/lib/ast"
import type { FlowResponse } from "@/lib/flow"

import { cppFlow } from "./flow"
import { cppTree } from "./tree"

const group = (res: FlowResponse, title: string) => res.groups!.find((g) => g.title.includes(title))!
const kinds = (res: FlowResponse, groupId: string, kind: string) =>
  res.nodes!.filter((n) => n.group === groupId && n.kind === kind)

describe("cppFlow", () => {
  it("builds the main function with io, decision, loop and return", async () => {
    const res = await cppFlow(
      "int main(){int n; std::cin>>n; if(n>0){std::cout<<n;} else {return 1;} for(int i=0;i<n;i++){} }",
      "en",
    )
    expect(res.ok).toBe(true)
    const main = group(res, "main")
    expect(main.kind).toBe("function")
    expect(kinds(res, main.id, "io")).toHaveLength(2)
    const decisions = kinds(res, main.id, "decision")
    expect(decisions).toHaveLength(1)
    const from = (kind: string, id: string) => res.edges!.filter((e) => e.source === id && e.kind === kind)
    expect(from("yes", decisions[0].id).length).toBeGreaterThan(0)
    expect(from("no", decisions[0].id).length).toBeGreaterThan(0)
    const loops = kinds(res, main.id, "loop")
    expect(loops).toHaveLength(1)
    expect(res.edges!.some((e) => e.kind === "repeat" && (e.source === loops[0].id || e.target === loops[0].id))).toBe(true)
    expect(kinds(res, main.id, "return")).toHaveLength(1)
    expect(kinds(res, main.id, "start")).toHaveLength(1)
    expect(kinds(res, main.id, "end")).toHaveLength(1)
  })

  it("links a call to the called function's group", async () => {
    const res = await cppFlow("int f(){return 1;} int main(){f();}", "en")
    expect(res.ok).toBe(true)
    const f = group(res, "f")
    const main = group(res, "main")
    const ids = new Map(res.nodes!.map((n) => [n.id, n]))
    expect(
      res.edges!.some((e) => e.kind === "call" && ids.get(e.source)?.group === main.id && ids.get(e.target)?.group === f.id),
    ).toBe(true)
  })

  it("makes a class group with a method group inside", async () => {
    const res = await cppFlow("struct P { void m(){} };", "en")
    expect(res.ok).toBe(true)
    const p = group(res, "P")
    const m = group(res, "m")
    expect(p.kind).toBe("class")
    expect(m.kind).toBe("method")
    expect(m.parent).toBe(p.id)
  })

  it("cuts off very deep nesting instead of overflowing the stack", async () => {
    const res = await cppFlow(`int main(){${"{".repeat(5000)}f();${"}".repeat(5000)}}`, "en")
    expect(res.ok).toBe(true)
    expect(res.truncated).toBe(true)
  })

  it("reports a syntax error with its line", async () => {
    const res = await cppFlow("int main( {", "en")
    expect(res.ok).toBe(false)
    expect(res.error?.line).toBe(1)
  })
})

describe("cppTree", () => {
  it("parses a declaration", async () => {
    const res = await cppTree("int x = 1;")
    expect(res.ok).toBe(true)
    const root = res.nodes![0]
    expect(root.type).toBe("translation_unit")
    expect(res.nodes!.some((n) => n.type === "number_literal" && n.fields.value === "1")).toBe(true)
  })

  it("reports a syntax error with its line", async () => {
    const res = await cppTree("int main( {")
    expect(res.ok).toBe(false)
    expect(res.error?.line).toBe(1)
  })

  it("categorizes cpp node types", () => {
    expect(categorize("number_literal", "cpp")).toBe("literal")
    expect(categorize("if_statement", "cpp")).toBe("statement")
  })
})
