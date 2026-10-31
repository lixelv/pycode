// Copies tree-sitter's runtime and the C++ grammar into public/tree-sitter/,
// where lib/cpp/parse.ts loads them for the C++ syntax tree and flowchart.
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const out = join(root, "public", "tree-sitter")
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
cpSync(join(root, "node_modules", "web-tree-sitter", "tree-sitter.wasm"), join(out, "tree-sitter.wasm"))
cpSync(join(root, "node_modules", "tree-sitter-cpp", "tree-sitter-cpp.wasm"), join(out, "tree-sitter-cpp.wasm"))
console.log("tree-sitter → public/tree-sitter/")
