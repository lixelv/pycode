import type { AstNodeData, AstResponse } from "@/lib/ast"

import { locOf, parseCpp, syntaxError, type Node } from "./parse"

const MAX_NODES = 1500

const scalar = (text: string) => (text.length <= 60 ? text : text.slice(0, 57) + "...")

/** The C++ syntax tree as the same node/edge graph `ast_tree.py` builds for Python. */
export async function cppTree(code: string): Promise<AstResponse> {
  const tree = await parseCpp(code)
  try {
    const error = syntaxError(tree.rootNode)
    if (error) return { ok: false, error }
    const lines = code.split("\n")
    const nodes: AstNodeData[] = []
    const edges: { source: string; target: string; label: string }[] = []
    let truncated = false

    const visit = (node: Node): string | null => {
      if (nodes.length >= MAX_NODES) {
        truncated = true
        return null
      }
      const id = String(nodes.length)
      // Leaves (identifiers, literals, types) show their text.
      const fields: Record<string, string> = node.namedChildCount === 0 ? { value: scalar(node.text) } : {}
      nodes.push({ id, type: node.type, fields, loc: locOf(node, lines) })
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i)
        if (!child?.isNamed) continue
        const target = visit(child)
        if (target !== null) edges.push({ source: id, target, label: node.fieldNameForChild(i) ?? "" })
      }
      return id
    }

    visit(tree.rootNode)
    return { ok: true, nodes, edges, truncated }
  } finally {
    tree.delete()
  }
}
