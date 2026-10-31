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

const CPP_EXPRESSIONS = new Set(["identifier", "field_identifier", "qualified_identifier"])

/** tree-sitter-cpp node types, by their name's suffix. */
function categorizeCpp(type: string): AstCategory {
  if (type === "translation_unit") return "module"
  if (/_(definition|declaration|declarator)$/.test(type) || type === "parameter_list") return "definition"
  if (type.endsWith("_literal") || type === "initializer_list") return "literal"
  if (type.endsWith("_expression") || CPP_EXPRESSIONS.has(type)) return "expression"
  if (type.endsWith("_statement")) return "statement"
  return "other"
}

export function categorize(type: string, lang: "python" | "cpp" = "python"): AstCategory {
  if (lang === "cpp") return categorizeCpp(type)
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

export type FlowNodeData = AstNodeData & { category: AstCategory; depth: number; leaf: boolean }
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

const NODE_GAP = 28
const RANK_GAP = 64
const MARGIN = 24

/**
 * A plain tree layout: children stand left to right in the order of their edges,
 * that is, in source order. Dagre's crossing reduction was free to swap them
 * (`right` to the left of `left`).
 */
export function layout(response: AstResponse, lang: "python" | "cpp" = "python"): { nodes: FlowNode[]; edges: Edge[] } {
  const sizes = new Map<string, { width: number; height: number }>()
  for (const node of response.nodes ?? []) sizes.set(node.id, nodeSize(node))

  const children = new Map<string, string[]>()
  const depth = new Map<string, number>()
  for (const edge of response.edges ?? []) {
    children.set(edge.source, [...(children.get(edge.source) ?? []), edge.target])
    depth.set(edge.target, 0)
  }
  const roots = (response.nodes ?? []).filter((n) => !depth.has(n.id)).map((n) => n.id)

  // Top of each level: as far down as the tallest node of the level above needs.
  const setDepth = (id: string, d: number) => {
    depth.set(id, d)
    for (const child of children.get(id) ?? []) setDepth(child, d + 1)
  }
  for (const root of roots) setDepth(root, 0)
  const rankHeight: number[] = []
  for (const [id, size] of sizes) rankHeight[depth.get(id)!] = Math.max(rankHeight[depth.get(id)!] ?? 0, size.height)
  const rankTop = [MARGIN]
  for (const height of rankHeight) rankTop.push(rankTop[rankTop.length - 1] + height + RANK_GAP)

  const position = new Map<string, { x: number; y: number }>()
  // Places a subtree from `left` on, its parent centred over its children; returns the subtree's right edge.
  const place = (id: string, left: number): number => {
    const size = sizes.get(id)!
    const kids = children.get(id) ?? []
    let right = left
    if (kids.length) {
      const span = kids.reduce((end, kid, i) => place(kid, i ? end + NODE_GAP : end), left)
      const center = (position.get(kids[0])!.x + position.get(kids[kids.length - 1])!.x + sizes.get(kids[kids.length - 1])!.width) / 2
      let x = center - size.width / 2
      if (x < left) {
        // The parent is wider than its children: move them under it.
        const shift = left - x
        const move = (n: string) => {
          position.get(n)!.x += shift
          ;(children.get(n) ?? []).forEach(move)
        }
        kids.forEach(move)
        x = left
        right = Math.max(span + shift, x + size.width)
      } else right = Math.max(span, x + size.width)
      position.set(id, { x, y: rankTop[depth.get(id)!] })
    } else {
      position.set(id, { x: left, y: rankTop[depth.get(id)!] })
      right = left + size.width
    }
    return right
  }
  roots.reduce((left, root) => place(root, left) + NODE_GAP, MARGIN)

  const nodes: FlowNode[] = (response.nodes ?? []).map((node) => {
    const size = sizes.get(node.id)!
    return {
      id: node.id,
      type: "ast",
      position: position.get(node.id)!,
      data: { ...node, category: categorize(node.type, lang), depth: depth.get(node.id) ?? 0, leaf: !children.has(node.id) },
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
