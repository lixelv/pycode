import { describe, expect, it } from "vitest"

import { DEFAULT_LAYOUT, TOOLS, activate, moveTool, normalizeLayout, resizeGroups, splitTool, visibleGroups, type ToolGroup } from "./lower-layout"

const names = (layout: ToolGroup[]) => layout.map((g) => g.tools)
const pair = (): ToolGroup[] => [
  { tools: ["console", "debug", "web"], active: "debug", size: 1 },
  { tools: ["tests", "tournament"], active: "tests", size: 1 },
]

describe("normalizeLayout", () => {
  it("starts with everything in one group", () => {
    expect(normalizeLayout(undefined)).toEqual(DEFAULT_LAYOUT)
    expect(normalizeLayout("nonsense")).toEqual(DEFAULT_LAYOUT)
    expect(normalizeLayout([{ tools: ["gone"] }])).toEqual(DEFAULT_LAYOUT)
  })

  it("keeps each tool once, drops unknown ones and gives missing ones to the first group", () => {
    const layout = normalizeLayout([{ tools: ["debug", "gone", "debug"], active: "gone", size: -1 }, { tools: ["debug", "console"], active: "console", size: 2 }, null])
    expect(layout[0]).toMatchObject({ active: "debug", size: 1 })
    expect(layout[1]).toEqual({ tools: ["console"], active: "console", size: 2 })
    expect(layout.flatMap((g) => g.tools).sort()).toEqual([...TOOLS].sort())
  })
})

describe("visibleGroups", () => {
  it("leaves out a group with nothing to show and keeps layout indexes", () => {
    expect(visibleGroups(pair(), ["tests", "console"]).map((g) => [g.index, g.tools])).toEqual([
      [0, ["console"]],
      [1, ["tests"]],
    ])
    expect(visibleGroups(pair(), ["console"]).map((g) => g.index)).toEqual([0])
  })

  it("falls back to the console, then the first tool, when the active one is gone", () => {
    expect(visibleGroups(pair(), ["web", "console"])[0].active).toBe("console")
    expect(visibleGroups([{ tools: ["web", "debug"], active: "tests" as never, size: 1 }], ["debug", "web"])[0].active).toBe("web")
  })
})

describe("changes", () => {
  it("activate touches only the tool's group", () => {
    const layout = activate(pair(), "console")
    expect(layout[0].active).toBe("console")
    expect(layout[1].active).toBe("tests")
  })

  it("moves a tab between groups and within one", () => {
    expect(names(moveTool(pair(), "tests", 0, "debug"))).toEqual([["console", "tests", "debug", "web"], ["tournament"]])
    expect(names(moveTool(pair(), "web", 0, "console"))[0]).toEqual(["web", "console", "debug"])
    expect(names(moveTool(pair(), "console", 0, null))[0]).toEqual(["debug", "web", "console"])
    expect(moveTool(pair(), "tests", 0, null)[1].active).toBe("tournament")
  })

  it("drops a group when its last tab leaves", () => {
    const layout: ToolGroup[] = [{ tools: ["console"], active: "console", size: 1 }, { tools: ["debug"], active: "debug", size: 1 }]
    expect(names(moveTool(layout, "debug", 0, null))).toEqual([["console", "debug"]])
  })

  it("splits to either side, sharing the width", () => {
    const left = splitTool(pair(), "tests", 0, "left")
    expect(names(left)).toEqual([["tests"], ["console", "debug", "web"], ["tournament"]])
    expect(left.map((g) => g.size)).toEqual([0.5, 0.5, 1])
    expect(names(splitTool(pair(), "debug", 0, "right"))).toEqual([["console", "web"], ["debug"], ["tests", "tournament"]])
  })

  it("splitting a lone tab off itself changes nothing", () => {
    const layout: ToolGroup[] = [{ tools: ["console"], active: "console", size: 3 }, { tools: ["debug"], active: "debug", size: 1 }]
    expect(splitTool(layout, "console", 0, "left")).toEqual(layout)
  })

  it("resizes within limits, keeping the joint width", () => {
    const [a, b] = resizeGroups(pair(), 0, 1, 0.99)
    expect(a.size).toBeCloseTo(1.7)
    expect(b.size).toBeCloseTo(0.3)
  })
})
