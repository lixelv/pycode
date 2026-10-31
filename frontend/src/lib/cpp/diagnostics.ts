/** One clang problem in the open file (1-based line and column). */
export interface ClangDiagnostic {
  line: number
  col: number
  severity: "error" | "warning"
  message: string
}

const DIAGNOSTIC = /^(.+?):(\d+):(\d+): (fatal error|error|warning|note|remark): (.*)$/
const INCLUDED = /^In file included from (.+?):(\d+):$/

const clean = (path: string) => path.replace(/^\.\//, "")

/**
 * Clang's log → problems of `entry`. A problem in another file shows at the
 * `#include` line of `entry` that pulls that file in (the outermost line of
 * clang's "In file included from" chain). Notes are dropped.
 */
export function parseClangDiagnostics(log: string, entry: string): ClangDiagnostic[] {
  const out: ClangDiagnostic[] = []
  // Clang prints the include chain only when it changes: remember where each header came in.
  const includedAt = new Map<string, number>()
  let chain: number | null = null
  for (const line of log.split("\n")) {
    const inc = INCLUDED.exec(line)
    if (inc) {
      if (chain === null && clean(inc[1]) === entry) chain = Number(inc[2])
      continue
    }
    const m = DIAGNOSTIC.exec(line)
    if (!m) continue
    const [, rawFile, row, col, kind, message] = m
    const file = clean(rawFile)
    if (file !== entry && chain !== null) includedAt.set(file, chain)
    chain = null
    if (kind === "note" || kind === "remark") continue
    const severity = kind === "warning" ? "warning" : "error"
    if (file === entry) out.push({ line: Number(row), col: Number(col), severity, message })
    else if (includedAt.has(file)) out.push({ line: includedAt.get(file)!, col: 1, severity, message: `${file}:${row}: ${message}` })
  }
  return out
}
