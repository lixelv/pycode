/*
 * How the tools under the editor are arranged: groups side by side, each with
 * its tabs and one shown (`[[console, debug], [tests]]`). Pure; kept per browser.
 * A new tool only needs a place in TOOLS: old saved layouts get it in the first group.
 */

export const TOOLS = ["web", "tests", "tournament", "debug", "console"] as const
export type Tool = (typeof TOOLS)[number]

export interface ToolGroup {
  tools: Tool[]
  active: Tool
  /** Its share of the width, relative to the other groups. */
  size: number
}

export type Side = "left" | "right"

export const DEFAULT_LAYOUT: ToolGroup[] = [{ tools: [...TOOLS], active: "console", size: 1 }]

/** Any JSON (localStorage can hold anything) as a layout with every tool exactly once. */
export function normalizeLayout(raw: unknown): ToolGroup[] {
  const seen = new Set<Tool>()
  const groups: ToolGroup[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    const group = item as Partial<ToolGroup> | null
    const tools: Tool[] = []
    for (const tool of Array.isArray(group?.tools) ? group.tools : []) {
      if (!TOOLS.includes(tool) || seen.has(tool)) continue
      seen.add(tool)
      tools.push(tool)
    }
    if (!tools.length) continue
    const size = typeof group?.size === "number" && Number.isFinite(group.size) && group.size > 0 ? group.size : 1
    groups.push({ tools, active: tools.includes(group?.active as Tool) ? (group?.active as Tool) : tools[0], size })
  }
  if (!groups.length) return DEFAULT_LAYOUT
  const missing = TOOLS.filter((tool) => !seen.has(tool))
  groups[0] = { ...groups[0], tools: [...groups[0].tools, ...missing] }
  return groups
}

/**
 * What to draw: groups with a tool available now (`index` is the group's place in the layout).
 * Sizes are scaled to add up to the groups' number: flex-grow below 1 in total leaves the rest of the width empty.
 */
export function visibleGroups(layout: ToolGroup[], available: readonly Tool[]) {
  const groups = layout.flatMap((group, index) => {
    const tools = group.tools.filter((tool) => available.includes(tool))
    if (!tools.length) return []
    const active = tools.includes(group.active) ? group.active : tools.includes("console") ? "console" : tools[0]
    return [{ index, tools, active, size: group.size }]
  })
  const total = groups.reduce((sum, group) => sum + group.size, 0)
  return groups.map((group) => ({ ...group, size: (group.size * groups.length) / total }))
}

/** Shows a tool in its group; the other groups stay as they are. */
export function activate(layout: ToolGroup[], tool: Tool): ToolGroup[] {
  return layout.map((group) => (group.tools.includes(tool) ? { ...group, active: tool } : group))
}

/** The layout without `tool`; a group left empty is gone, and so is its place. */
function without(layout: ToolGroup[], tool: Tool): (ToolGroup | null)[] {
  return layout.map((group) => {
    if (!group.tools.includes(tool)) return group
    const tools = group.tools.filter((other) => other !== tool)
    return tools.length ? { ...group, tools, active: group.active === tool ? tools[0] : group.active } : null
  })
}

/** Puts `tool` into group `target`, before the tab `before` (null: last), and shows it. */
export function moveTool(layout: ToolGroup[], tool: Tool, target: number, before: Tool | null): ToolGroup[] {
  return without(layout, tool).flatMap((group, index) => {
    const into = index === target ? (group ?? layout[index]) : null
    if (!into) return group ? [group] : []
    const tools = into.tools.filter((other) => other !== tool)
    const at = before && before !== tool ? tools.indexOf(before) : -1
    tools.splice(at < 0 ? tools.length : at, 0, tool)
    return [{ ...into, tools, active: tool }]
  })
}

/** Gives `tool` a group of its own on one side of group `target`, sharing that group's width. */
export function splitTool(layout: ToolGroup[], tool: Tool, target: number, side: Side): ToolGroup[] {
  const size = layout[target].size / 2
  return without(layout, tool).flatMap((group, index) => {
    if (index !== target) return group ? [group] : []
    const own: ToolGroup = { tools: [tool], active: tool, size: group ? size : layout[target].size }
    if (!group) return [own] // it was alone there: nothing to split
    const rest = { ...group, size }
    return side === "left" ? [own, rest] : [rest, own]
  })
}

/** Sets the border between two groups: `ratio` of their joint width goes to the first. */
export function resizeGroups(layout: ToolGroup[], first: number, second: number, ratio: number): ToolGroup[] {
  const total = layout[first].size + layout[second].size
  const share = Math.min(0.85, Math.max(0.15, ratio))
  return layout.map((group, index) => (index === first ? { ...group, size: total * share } : index === second ? { ...group, size: total * (1 - share) } : group))
}
