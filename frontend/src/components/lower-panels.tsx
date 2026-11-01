import { Fragment, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"

import { moveTool, resizeGroups, splitTool, visibleGroups, type Side, type Tool, type ToolGroup } from "@/lib/lower-layout"
import { cn } from "@/lib/utils"

/** Our own tabs in a drag; not "Files", so useFileDrop leaves it alone. */
const TOOL_DRAG = "application/x-polycode-tool"
/** The part of a panel, on each side, that splits it rather than joins it. */
const SPLIT_ZONE = 0.25
/** Their state lives in them (a page, the input line's focus): hidden, not unmounted. */
const KEEP_MOUNTED: readonly Tool[] = ["web", "console"]

type Zone = { group: number; side: Side | "center" } | { group: number; before: Tool }

export function LowerPanels({
  layout,
  onLayout,
  tools,
  onActivate,
  render,
}: {
  layout: ToolGroup[]
  onLayout: (next: ToolGroup[]) => void
  /** The tools available now, with their tab captions. */
  tools: { id: Tool; label: string }[]
  onActivate: (tool: Tool) => void
  render: (tool: Tool, tabs: ReactNode, visible: boolean) => ReactNode
}) {
  const [dragging, setDragging] = useState<Tool | null>(null)
  const [zone, setZone] = useState<Zone | null>(null)
  const row = useRef<HTMLDivElement>(null)
  const groups = visibleGroups(layout, tools.map((tool) => tool.id))
  const labelOf = (id: Tool) => tools.find((tool) => tool.id === id)?.label

  const endDrag = () => {
    setDragging(null)
    setZone(null)
  }

  const overTab = (e: DragEvent, group: number, tool: Tool, tabs: Tool[]) => {
    if (!dragging) return
    e.preventDefault()
    const box = e.currentTarget.getBoundingClientRect()
    const next = tabs[tabs.indexOf(tool) + 1]
    const before = e.clientX < box.left + box.width / 2 ? tool : next
    setZone(before ? { group, before } : { group, side: "center" })
  }

  const overPanel = (e: DragEvent, group: number) => {
    e.preventDefault()
    const box = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - box.left) / box.width
    setZone({ group, side: x < SPLIT_ZONE ? "left" : x > 1 - SPLIT_ZONE ? "right" : "center" })
  }

  const drop = (e: DragEvent) => {
    e.preventDefault()
    if (dragging && zone) {
      if ("before" in zone) onLayout(moveTool(layout, dragging, zone.group, zone.before))
      else if (zone.side === "center") onLayout(moveTool(layout, dragging, zone.group, null))
      else onLayout(splitTool(layout, dragging, zone.group, zone.side))
    }
    endDrag()
  }

  const startResize = (e: ReactPointerEvent, first: number, second: number, left: HTMLElement | null, right: HTMLElement | null) => {
    e.preventDefault()
    if (!left || !right) return
    const start = left.getBoundingClientRect().left
    const width = right.getBoundingClientRect().right - start
    let current = layout
    const onMove = (ev: PointerEvent) => {
      current = resizeGroups(current, first, second, (ev.clientX - start) / width)
      onLayout(current)
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.cursor = ""
    }
    document.body.style.cursor = "col-resize"
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  return (
    <div ref={row} className="flex h-full min-w-0">
      {groups.map((group, position) => {
        const tabs =
          tools.length > 1 ? (
            <nav role="tablist" className="inline-flex min-w-0 overflow-hidden rounded-md border border-console-border p-0.5" onDrop={drop} onDragOver={(e) => dragging && e.preventDefault()}>
              {group.tools.map((tool) => (
                <button
                  key={tool}
                  role="tab"
                  draggable
                  aria-selected={group.active === tool}
                  onClick={() => onActivate(tool)}
                  onDragStart={(e) => {
                    e.dataTransfer.setData(TOOL_DRAG, tool)
                    e.dataTransfer.effectAllowed = "move"
                    // Changing the page inside dragstart can cancel the drag in Chrome.
                    setTimeout(() => setDragging(tool))
                  }}
                  onDragEnd={endDrag}
                  onDragOver={(e) => overTab(e, group.index, tool, group.tools)}
                  className={cn(
                    "shrink-0 rounded-[4px] px-2 py-0.5 text-[11px] font-medium tracking-wider uppercase",
                    group.active === tool ? "bg-white/10 text-console-foreground" : "text-console-muted hover:text-console-foreground",
                    zone && "before" in zone && zone.group === group.index && zone.before === tool && "shadow-[inset_2px_0_0_0_var(--primary)]",
                  )}
                >
                  {labelOf(tool)}
                </button>
              ))}
            </nav>
          ) : undefined
        const next = groups[position + 1]
        const shown = zone && !("before" in zone) && zone.group === group.index ? zone.side : null
        return (
          <Fragment key={group.index}>
            <div data-tool-group={group.index} style={{ flexGrow: group.size, flexBasis: 0 }} className="relative h-full min-w-0">
              {group.tools.map((tool) => {
                const visible = tool === group.active
                return (
                  <div key={tool} className={cn("h-full", !visible && "hidden")}>
                    {(visible || KEEP_MOUNTED.includes(tool)) && render(tool, tabs, visible)}
                  </div>
                )
              })}
              {/* Below the header, so tabs stay drop targets; above a page's frame, which would swallow the drag. */}
              {dragging && (
                <div className="absolute inset-x-0 top-9 bottom-0 z-10" data-tool-drop onDragOver={(e) => overPanel(e, group.index)} onDragLeave={() => setZone(null)} onDrop={drop}>
                  {shown && <div className={cn("pointer-events-none absolute inset-y-0 border border-primary/50 bg-primary/15", shown === "left" ? "left-0 w-1/2" : shown === "right" ? "right-0 w-1/2" : "inset-x-0")} />}
                </div>
              )}
            </div>
            {next && (
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panels"
                onPointerDown={(e) => {
                  const find = (index: number) => row.current?.querySelector<HTMLElement>(`[data-tool-group="${index}"]`) ?? null
                  startResize(e, group.index, next.index, find(group.index), find(next.index))
                }}
                className="group relative z-10 w-px shrink-0 cursor-col-resize bg-console-border"
              >
                <div className="absolute inset-y-0 -right-2 -left-2 cursor-col-resize" />
              </div>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
