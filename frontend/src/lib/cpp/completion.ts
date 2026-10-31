/** One suggestion from clang's `-code-completion-at`; overloads of a name are merged. */
export interface CppCompletion {
  name: string
  kind: "function" | "variable" | "type" | "keyword"
  detail: string
  snippet: string
  overloads: number
}

const clean = (text: string) =>
  text
    .replace(/\{#|#\}/g, "")
    .replace(/<#|#>/g, "")
    .replace(/\[#|#\]/g, "")

/** The lines clang prints in completion mode, for the editor. */
export function parseCompletions(log: string): CppCompletion[] {
  const byName = new Map<string, CppCompletion>()
  for (const line of log.split("\n")) {
    const match = /^COMPLETION: (\S+)(?: (\(Hidden\)))?(?: : (.*))?$/.exec(line)
    if (!match) continue
    const [, name, hidden, text] = match
    if (hidden || name === "Pattern" || name.startsWith("_") || name.startsWith("~") || name.startsWith("operator")) continue
    const known = byName.get(name)
    if (known) {
      known.overloads++
      if (known.kind === "function") known.snippet = `${name}($0)`
      continue
    }
    if (text === undefined) {
      byName.set(name, { name, kind: "keyword", detail: "", snippet: name, overloads: 0 })
      continue
    }
    const result = /^\[#(.*?)#\]/.exec(text)
    const rest = result ? text.slice(result[0].length) : text
    const detail = `${result ? `${result[1]} ` : ""}${clean(rest)}`
    if (!rest.startsWith(`${name}(`) && !rest.includes(">(")) {
      byName.set(name, { name, kind: result ? "variable" : "type", detail, snippet: name, overloads: 0 })
      continue
    }
    // Required parameters only: `{#…#}` holds the optional ones.
    const required = [...rest.replace(/\{#.*#\}/g, "").matchAll(/<#(.*?)#>/g)].map((m) => m[1])
    const parameters = required.map((p, i) => `\${${i + 1}:${p.replace(/[$}\\]/g, "\\$&")}}`).join(", ")
    byName.set(name, { name, kind: "function", detail, snippet: parameters ? `${name}(${parameters})` : `${name}()$0`, overloads: 0 })
  }
  return [...byName.values()]
}

/**
 * Splits off what a precompiled header can hold: the leading `#include <…>`
 * lines (with comments and blanks between them). `body` keeps every line
 * number. A project include stops it, since its file can change at any moment.
 */
export function splitPreamble(source: string): { preamble: string; body: string } {
  const lines = source.split("\n")
  let preamble = ""
  let end = 0
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim()
    if (/^#\s*include\s*<[^>]+>/.test(line)) {
      preamble += `${lines[i]}\n`
      end = i + 1
    } else if (line !== "" && !line.startsWith("//")) break
  }
  return { preamble, body: "\n".repeat(end) + lines.slice(end).join("\n") }
}

/** A 1-based Monaco (UTF-16) column as clang's 1-based byte column. */
export const byteColumn = (lineText: string, column: number) => new TextEncoder().encode(lineText.slice(0, column - 1)).length + 1

/** Whether to ask at all, given the line up to the cursor: not for a lone `>` or `:`, in a comment, a string or a preprocessor line. */
export function wantsCompletion(before: string, trigger?: string): boolean {
  if (trigger === ">" && !before.endsWith("->")) return false
  if (trigger === ":" && !before.endsWith("::")) return false
  if (/^\s*#/.test(before)) return false
  const code = before.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, "")
  return !code.includes("//") && !code.includes('"')
}
