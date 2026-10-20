import dagre from "@dagrejs/dagre"
import type { Edge, Node } from "@xyflow/react"

export interface AstLoc {
  line: number
  col: number
  endLine: number
  endCol: number
}

// A type alias (not an interface) so it satisfies React Flow's data constraint.
export type AstNodeData = {
  id: string
  type: string
  fields: Record<string, string>
  loc?: AstLoc
}

export interface AstResponse {
  ok: boolean
  nodes?: AstNodeData[]
  edges?: { source: string; target: string; label: string }[]
  truncated?: boolean
  error?: { message: string; line?: number; col?: number }
}

export type AstCategory = "module" | "definition" | "statement" | "expression" | "literal" | "other"

const DEFINITIONS = new Set(["FunctionDef", "AsyncFunctionDef", "ClassDef", "Lambda", "arguments", "arg"])
const LITERALS = new Set(["Constant", "JoinedStr", "FormattedValue", "List", "Tuple", "Set", "Dict"])
const EXPRESSIONS = new Set([
  "Name", "BinOp", "BoolOp", "UnaryOp", "Compare", "Call", "Attribute", "Subscript", "Slice",
  "ListComp", "SetComp", "DictComp", "GeneratorExp", "IfExp", "Await", "Yield", "YieldFrom",
  "Starred", "NamedExpr", "keyword", "comprehension",
])

export function categorize(type: string): AstCategory {
  if (type === "Module") return "module"
  if (DEFINITIONS.has(type)) return "definition"
  if (LITERALS.has(type)) return "literal"
  if (EXPRESSIONS.has(type)) return "expression"
  if (/^[A-Z]/.test(type)) return "statement"
  return "other"
}

export const CATEGORY_COLORS: Record<AstCategory, string> = {
  module: "var(--foreground)",
  definition: "var(--chart-4)",
  statement: "var(--chart-1)",
  expression: "var(--chart-2)",
  literal: "var(--chart-3)",
  other: "var(--muted-foreground)",
}

export type FlowNodeData = AstNodeData & { category: AstCategory; depth: number }
export type FlowNode = Node<FlowNodeData, "ast">

const CHAR_W = 7.3
const NODE_MIN_W = 110
const NODE_MAX_W = 300

function nodeSize(node: AstNodeData) {
  const lines = Object.entries(node.fields).map(([k, v]) => `${k} = ${v}`.length)
  const longest = Math.max(node.type.length + 4, ...lines)
  const width = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, longest * CHAR_W + 28))
  const height = 34 + Object.keys(node.fields).length * 18 + (lines.length ? 6 : 0)
  return { width, height }
}

export function layout(response: AstResponse): { nodes: FlowNode[]; edges: Edge[] } {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: "TB", nodesep: 28, ranksep: 64, marginx: 24, marginy: 24 })
  g.setDefaultEdgeLabel(() => ({}))

  const sizes = new Map<string, { width: number; height: number }>()
  for (const node of response.nodes ?? []) {
    const size = nodeSize(node)
    sizes.set(node.id, size)
    g.setNode(node.id, size)
  }
  for (const edge of response.edges ?? []) g.setEdge(edge.source, edge.target)
  dagre.layout(g)

  const depth = new Map<string, number>([["0", 0]])
  for (const edge of response.edges ?? []) depth.set(edge.target, (depth.get(edge.source) ?? 0) + 1)

  const nodes: FlowNode[] = (response.nodes ?? []).map((node) => {
    const pos = g.node(node.id)
    const size = sizes.get(node.id)!
    return {
      id: node.id,
      type: "ast",
      position: { x: pos.x - size.width / 2, y: pos.y - size.height / 2 },
      data: { ...node, category: categorize(node.type), depth: depth.get(node.id) ?? 0 },
      style: { width: size.width },
    }
  })
  const edges: Edge[] = (response.edges ?? []).map((edge) => ({
    id: `${edge.source}-${edge.target}`,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    type: "default",
  }))
  return { nodes, edges }
}

/** Python reports columns as UTF-8 byte offsets; slice accordingly. */
export function sourceSegment(code: string, loc: AstLoc): string {
  const lines = code.split("\n")
  const enc = new TextEncoder()
  const dec = new TextDecoder()
  const out: string[] = []
  for (let line = loc.line; line <= loc.endLine; line++) {
    const bytes = enc.encode(lines[line - 1] ?? "")
    const start = line === loc.line ? loc.col : 0
    const end = line === loc.endLine ? loc.endCol : bytes.length
    out.push(dec.decode(bytes.slice(start, end)))
  }
  return out.join("\n")
}

/** Converts a UTF-8 byte column to a 1-based Monaco (UTF-16) column. */
export function toEditorColumn(code: string, line: number, byteCol: number): number {
  const text = code.split("\n")[line - 1] ?? ""
  const bytes = new TextEncoder().encode(text).slice(0, byteCol)
  return new TextDecoder().decode(bytes).length + 1
}
