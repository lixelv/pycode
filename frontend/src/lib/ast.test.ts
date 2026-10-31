import { describe, expect, it } from "vitest"

import { layout } from "./ast"
import { cppTree } from "./cpp/tree"

describe("layout", () => {
  it("keeps children in source order, at any depth", async () => {
    const tree = await cppTree("int main() { int x = a + b; return a * (b - c) + d; }\n")
    const { nodes } = layout(tree, "cpp")
    const x = new Map(nodes.map((n) => [n.id, n.position.x]))
    const pairs = (tree.edges ?? []).filter((e) => e.label === "left")
    expect(pairs.length).toBe(4)
    for (const left of pairs) {
      const right = tree.edges!.find((e) => e.source === left.source && e.label === "right")!
      expect(x.get(left.target)!).toBeLessThan(x.get(right.target)!)
    }
  })

  it("does not overlap nodes of one level and puts a parent above its child", async () => {
    const tree = await cppTree("int f(int a, int b) { if (a) { return a + b; } return f(a, b) * 2; }\nint main() { return f(1, 2); }\n")
    const { nodes } = layout(tree, "cpp")
    const levels = new Map<number, typeof nodes>()
    for (const n of nodes) levels.set(n.position.y, [...(levels.get(n.position.y) ?? []), n])
    for (const level of levels.values()) {
      const sorted = [...level].sort((a, b) => a.position.x - b.position.x)
      sorted.slice(1).forEach((n, i) => expect(n.position.x).toBeGreaterThanOrEqual(sorted[i].position.x + (sorted[i].style!.width as number)))
    }
    const y = new Map(nodes.map((n) => [n.id, n.position.y]))
    for (const e of tree.edges!) expect(y.get(e.target)!).toBeGreaterThan(y.get(e.source)!)
  })
})
