import type { Edge, Node } from "@xyflow/react"

import type { AstLoc } from "@/lib/ast"
import { getLang } from "@/lib/i18n"

export type FlowKind =
  | "start" | "end" | "statement" | "io" | "decision" | "loop" | "define" | "class"
  | "return" | "jump" | "try" | "except"
export type FlowEdgeKind = "next" | "yes" | "no" | "repeat" | "call" | "create" | "inherit" | "define"

export type FlowStep = {
  id: string
  kind: FlowKind
  label: string
  caption: string
  group: string | null
  loc?: AstLoc
}

export interface FlowGroup {
  id: string
  title: string
  kind: "function" | "method" | "class"
  parent: string | null
}

export interface FlowResponse {
  ok: boolean
  nodes?: FlowStep[]
  edges?: { source: string; target: string; label: string | null; kind: FlowEdgeKind }[]
  groups?: FlowGroup[]
  truncated?: boolean
  error?: { message: string; line?: number }
}

const RU_TAGS: Partial<Record<string, string>> = {
  Start: "Начало", End: "Конец", Step: "Шаг", "Input / output": "Ввод / вывод", Condition: "Условие",
  Loop: "Цикл", Definition: "Определение", Class: "Класс", Return: "Возврат", Jump: "Переход", Try: "Попытка",
  "On error": "При ошибке",
}

/** The kind's label in the interface language. */
export const kindTag = (kind: FlowKind) => (getLang() === "ru" ? RU_TAGS[KIND_META[kind].tag] : undefined) ?? KIND_META[kind].tag

export const KIND_META: Record<FlowKind, { tag: string; color: string }> = {
  start: { tag: "Start", color: "var(--foreground)" },
  end: { tag: "End", color: "var(--foreground)" },
  statement: { tag: "Step", color: "var(--muted-foreground)" },
  io: { tag: "Input / output", color: "var(--chart-3)" },
  decision: { tag: "Condition", color: "var(--chart-5)" },
  loop: { tag: "Loop", color: "var(--chart-1)" },
  define: { tag: "Definition", color: "var(--chart-2)" },
  class: { tag: "Class", color: "var(--chart-4)" },
  return: { tag: "Return", color: "var(--chart-2)" },
  jump: { tag: "Jump", color: "var(--chart-4)" },
  try: { tag: "Try", color: "var(--chart-4)" },
  except: { tag: "On error", color: "var(--chart-4)" },
}

export const EDGE_COLORS: Record<FlowEdgeKind, string> = {
  next: "var(--muted-foreground)",
  yes: "var(--chart-3)",
  no: "var(--destructive)",
  repeat: "var(--chart-1)",
  call: "var(--chart-2)",
  create: "var(--chart-4)",
  inherit: "var(--chart-4)",
  define: "var(--muted-foreground)",
}
export const DASHED: Partial<Record<FlowEdgeKind, string>> = { call: "6 4", create: "6 4", inherit: "2 4", define: "2 4" }

export const GROUP_COLORS: Record<FlowGroup["kind"], string> = {
  function: "var(--chart-2)",
  method: "var(--chart-2)",
  class: "var(--chart-4)",
}

export type FlowNodeData = FlowStep & { step: number }
export type FrameData = { title: string; kind: FlowGroup["kind"] }
export type FlowGraphNode = Node<FlowNodeData, "step"> | Node<FrameData, "frame">
export type RoutedEdgeData = { points: { x: number; y: number }[]; labelAt?: { x: number; y: number }; color: string; dash?: string }

const WIDTH = 270
const PILL_WIDTH = 190
const FRAME_TITLE = 34

function size(step: FlowStep) {
  if (step.kind === "start" || step.kind === "end") return { width: PILL_WIDTH, height: 40 }
  const captionLines = Math.ceil((step.caption.length * 6.4) / (WIDTH - 32))
  return { width: WIDTH, height: 54 + captionLines * 16 }
}

type ElkNode = {
  id: string
  width?: number
  height?: number
  x?: number
  y?: number
  children?: ElkNode[]
  layoutOptions?: Record<string, string>
}
type ElkEdge = {
  id: string
  sources: string[]
  targets: string[]
  labels?: { text: string; width: number; height: number; x?: number; y?: number }[]
  sections?: { startPoint: { x: number; y: number }; endPoint: { x: number; y: number }; bendPoints?: { x: number; y: number }[] }[]
  layoutOptions?: Record<string, string>
}

const ROOT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  // Edges between frames are laid out together with everything inside them.
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.edgeRouting": "ORTHOGONAL",
  "elk.json.shapeCoords": "ROOT",
  "elk.json.edgeCoords": "ROOT",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.feedbackEdges": "true",
  "elk.spacing.nodeNode": "48",
  "elk.layered.spacing.nodeNodeBetweenLayers": "56",
  "elk.spacing.edgeNode": "28",
  "elk.spacing.edgeEdge": "16",
  "elk.layered.spacing.edgeNodeBetweenLayers": "28",
  "elk.spacing.edgeLabel": "6",
  "elk.edgeLabels.placement": "CENTER",
  "elk.padding": "[top=32,left=32,bottom=32,right=32]",
}
const FRAME_OPTIONS: Record<string, string> = {
  "elk.padding": `[top=${FRAME_TITLE + 14},left=24,bottom=24,right=24]`,
}

type ElkGraph = ElkNode & { edges: ElkEdge[] }
type ElkLayout = { layout: (g: ElkGraph) => Promise<ElkGraph> }

let elkInstance: Promise<ElkLayout> | null = null
function elk() {
  // Loaded on demand: only the flowchart needs it.
  elkInstance ??= import("elkjs/lib/elk.bundled.js").then((m) => new m.default() as unknown as ElkLayout)
  return elkInstance
}

/**
 * Lays the flowchart out with ELK (layered, hierarchical): classes, functions
 * and methods are nested frames that never overlap, and every edge gets an
 * orthogonal route around the cards, including links between frames.
 */
export async function layoutFlow(data: FlowResponse): Promise<{ nodes: FlowGraphNode[]; edges: Edge<RoutedEdgeData>[] }> {
  const steps = data.nodes ?? []
  const groups = data.groups ?? []
  const elkNodes = new Map<string, ElkNode>()
  const frameId = (group: string) => `frame:${group}`

  for (const group of groups) elkNodes.set(frameId(group.id), { id: frameId(group.id), children: [], layoutOptions: FRAME_OPTIONS })
  for (const step of steps) elkNodes.set(step.id, { id: step.id, ...size(step) })

  const root: ElkNode & { edges: ElkEdge[] } = { id: "root", layoutOptions: ROOT_OPTIONS, children: [], edges: [] }
  const parentOf = (_id: string, group: string | null) => (group ? elkNodes.get(frameId(group)) : root) ?? root
  for (const group of groups) parentOf(frameId(group.id), group.parent).children!.push(elkNodes.get(frameId(group.id))!)
  for (const step of steps) parentOf(step.id, step.group).children!.push(elkNodes.get(step.id)!)

  const edges = data.edges ?? []
  root.edges = edges.map((e, i) => ({
    id: `e${i}`,
    sources: [e.source],
    targets: [e.target],
    labels: e.label ? [{ text: e.label, width: e.label.length * 6.8 + 14, height: 18 }] : [],
  }))

  const laid = await (await elk()).layout(root)

  const shapes = new Map<string, ElkNode>()
  const walk = (n: ElkNode) => {
    shapes.set(n.id, n)
    n.children?.forEach(walk)
  }
  walk(laid)

  const depth = (group: FlowGroup) => {
    let d = 0
    for (let p = group.parent; p; p = groups.find((x) => x.id === p)?.parent ?? null) d++
    return d
  }
  const frames: FlowGraphNode[] = [...groups]
    .sort((a, b) => depth(a) - depth(b))
    .map((group) => {
      const f = shapes.get(frameId(group.id))!
      return {
        id: frameId(group.id),
        type: "frame",
        position: { x: f.x ?? 0, y: f.y ?? 0 },
        data: { title: group.title, kind: group.kind },
        style: { width: f.width, height: f.height },
        selectable: false,
        draggable: false,
        zIndex: depth(group),
      }
    })

  // Number the steps in the order a reader meets them in the code.
  const order = [...steps].sort((a, b) => (a.loc?.line ?? 0) - (b.loc?.line ?? 0))
  const numbers = new Map(order.filter((s) => s.kind !== "start" && s.kind !== "end").map((s, i) => [s.id, i + 1]))

  const stepNodes: FlowGraphNode[] = steps.map((step) => {
    const n = shapes.get(step.id)!
    return {
      id: step.id,
      type: "step",
      position: { x: n.x ?? 0, y: n.y ?? 0 },
      data: { ...step, step: numbers.get(step.id) ?? 0 },
      style: { width: n.width },
      draggable: false,
      zIndex: 20,
    }
  })

  const routed: Edge<RoutedEdgeData>[] = (laid.edges ?? []).map((le, i) => {
    const e = edges[i]
    const section = le.sections?.[0]
    const points = section ? [section.startPoint, ...(section.bendPoints ?? []), section.endPoint] : []
    const label = le.labels?.[0]
    return {
      id: le.id,
      source: e.source,
      target: e.target,
      type: "routed",
      label: e.label ?? undefined,
      data: {
        points,
        labelAt: label && label.x !== undefined && label.y !== undefined ? { x: label.x + label.width / 2, y: label.y + label.height / 2 } : undefined,
        color: EDGE_COLORS[e.kind],
        dash: DASHED[e.kind],
      },
      zIndex: 10,
    }
  })

  return { nodes: [...frames, ...stepNodes], edges: routed }
}

/** An orthogonal route with rounded corners. */
export function roundedPath(points: { x: number; y: number }[], radius = 10): string {
  if (points.length === 0) return ""
  let d = `M${points[0].x},${points[0].y}`
  for (let i = 1; i < points.length - 1; i++) {
    const [a, b, c] = [points[i - 1], points[i], points[i + 1]]
    const r = Math.min(radius, Math.hypot(b.x - a.x, b.y - a.y) / 2, Math.hypot(c.x - b.x, c.y - b.y) / 2)
    const p1 = { x: b.x + ((a.x - b.x) / (Math.hypot(a.x - b.x, a.y - b.y) || 1)) * r, y: b.y + ((a.y - b.y) / (Math.hypot(a.x - b.x, a.y - b.y) || 1)) * r }
    const p2 = { x: b.x + ((c.x - b.x) / (Math.hypot(c.x - b.x, c.y - b.y) || 1)) * r, y: b.y + ((c.y - b.y) / (Math.hypot(c.x - b.x, c.y - b.y) || 1)) * r }
    d += `L${p1.x},${p1.y}Q${b.x},${b.y} ${p2.x},${p2.y}`
  }
  const last = points[points.length - 1]
  return d + `L${last.x},${last.y}`
}

