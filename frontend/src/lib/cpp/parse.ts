import { Language, Parser, type Node, type Tree } from "web-tree-sitter"

import type { AstLoc } from "@/lib/ast"

export type { Node, Tree }

let parser: Promise<Parser> | null = null

// In the page the wasm files come from public/tree-sitter/ (copy-tree-sitter.mjs);
// under vitest (node) straight from node_modules.
const inBrowser = typeof window !== "undefined"

function load(): Promise<Parser> {
  parser ??= (async () => {
    await Parser.init(inBrowser ? { locateFile: (name: string) => `/tree-sitter/${name}` } : undefined)
    const cpp = await Language.load(inBrowser ? "/tree-sitter/tree-sitter-cpp.wasm" : "node_modules/tree-sitter-cpp/tree-sitter-cpp.wasm")
    const p = new Parser()
    p.setLanguage(cpp)
    return p
  })()
  // A failed load (e.g. offline) is retried on the next call.
  parser.catch(() => {
    parser = null
  })
  return parser
}

/** Parses C++ with tree-sitter (loaded on first use). The caller deletes the tree. */
export async function parseCpp(code: string): Promise<Tree> {
  const tree = (await load()).parse(code)
  if (!tree) throw new Error("tree-sitter could not parse the code")
  return tree
}

/** The first ERROR or MISSING node, as the same error shape Python reports. */
export function syntaxError(root: Node): { message: string; line: number } | null {
  if (!root.hasError) return null
  // Depth-first, first match in source order; iterative because code may nest deeply.
  let bad = root
  const stack = [root]
  for (let n = stack.pop(); n; n = stack.pop()) {
    if (n.isError || n.isMissing) {
      bad = n
      break
    }
    for (const child of [...n.children].reverse()) if (child && (child.hasError || child.isMissing)) stack.push(child)
  }
  const line = bad.startPosition.row + 1
  if (bad.isMissing) return { message: `Missing “${bad.type}”`, line }
  return { message: "Invalid syntax", line }
}

/**
 * The node's location with UTF-8 byte columns, like Python's AST, so the
 * dialog's sourceSegment and the editor's reveal work the same for both.
 */
export function locOf(node: Node, lines: string[]): AstLoc {
  const bytes = (row: number, col: number) => new TextEncoder().encode((lines[row] ?? "").slice(0, col)).length
  const { startPosition: s, endPosition: e } = node
  return { line: s.row + 1, col: bytes(s.row, s.column), endLine: e.row + 1, endCol: bytes(e.row, e.column) }
}
