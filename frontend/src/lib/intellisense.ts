import { monaco, type MonacoApi } from "@/lib/monaco"
import { callTool } from "@/lib/python/tools-client"

type Kind = "complete" | "signature" | "hover"

interface JediCompletion {
  name: string
  type: string
  complete: string
  description: string
  signature?: string
  doc?: string
}
interface JediSignature {
  label: string
  params: string[]
  index: number | null
  doc: string
}
interface JediHover {
  header: string
  doc: string
}

async function ask<T>(
  kind: Kind,
  model: MonacoApi.editor.ITextModel,
  position: MonacoApi.Position,
  token: MonacoApi.CancellationToken,
): Promise<T | null> {
  try {
    // Jedi columns are 0-based, Monaco's are 1-based.
    const result = await callTool<T>(kind, { code: model.getValue(), line: position.lineNumber, column: position.column - 1, path: model.uri.path })
    return token.isCancellationRequested ? null : result
  } catch {
    return null
  }
}

/** Docstrings are plain text: escape markdown and keep line breaks. */
function plain(text: string): MonacoApi.IMarkdownString {
  const escaped = text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, "\\$&").replace(/^( +)/gm, (m) => "&nbsp;".repeat(m.length))
  return { value: escaped.replace(/\n/g, "  \n"), supportHtml: false }
}

const K = monaco.languages.CompletionItemKind
const KIND: Record<string, MonacoApi.languages.CompletionItemKind> = {
  module: K.Module,
  class: K.Class,
  instance: K.Variable,
  function: K.Function,
  param: K.Variable,
  path: K.File,
  keyword: K.Keyword,
  property: K.Property,
  statement: K.Variable,
}

const SNIPPETS: [string, string, string][] = [
  ["def", "def ${1:name}(${2:args}):\n\t${0:pass}", "Function definition"],
  ["class", "class ${1:Name}:\n\tdef __init__(self${2:, args}):\n\t\t${0:pass}", "Class definition"],
  ["for", "for ${1:item} in ${2:iterable}:\n\t${0:pass}", "for loop"],
  ["forr", "for ${1:i} in range(${2:10}):\n\t${0:pass}", "for loop over range()"],
  ["while", "while ${1:condition}:\n\t${0:pass}", "while loop"],
  ["if", "if ${1:condition}:\n\t${0:pass}", "if statement"],
  ["ifelse", "if ${1:condition}:\n\t${2:pass}\nelse:\n\t${0:pass}", "if / else"],
  ["try", "try:\n\t${1:pass}\nexcept ${2:Exception} as ${3:e}:\n\t${0:print($3)}", "try / except"],
  ["with", "with ${1:open(\"file.txt\")} as ${2:f}:\n\t${0:pass}", "with statement"],
  ["main", 'def main():\n\t${0:pass}\n\n\nif __name__ == "__main__":\n\tmain()', "main() entry point"],
  ["lc", "[${1:x} for ${1:x} in ${2:iterable}]", "List comprehension"],
  ["inp", '${1:value} = input("${2:Enter a value: }")', "Read a line with input()"],
]

let registered = false

/** Registers Jedi-backed completions, signature help and hovers for Python. */
export function registerPythonIntellisense() {
  if (registered) return
  registered = true

  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: ["."],
    async provideCompletionItems(model, position, _context, token) {
      const word = model.getWordUntilPosition(position)
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      }
      const line = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
      const afterDot = /\.\s*\w*$/.test(line)
      const inComment = /#/.test(line.replace(/(["']).*?\1/g, ""))
      if (inComment) return { suggestions: [] }

      const items = (await ask<JediCompletion[]>("complete", model, position, token)) ?? []
      const suggestions: MonacoApi.languages.CompletionItem[] = items.map((c, i) => ({
        label: { label: c.name, description: c.signature ? undefined : c.type },
        kind: KIND[c.type] ?? K.Text,
        insertText: c.name,
        range,
        detail: c.signature,
        documentation: c.doc ? plain(c.doc) : undefined,
        sortText: String(i).padStart(4, "0"),
      }))

      // Snippets only make sense at the start of a statement.
      if (!afterDot && /^\s*\w*$/.test(line)) {
        for (const [label, body, doc] of SNIPPETS) {
          suggestions.push({
            label: { label, description: "snippet" },
            kind: K.Snippet,
            insertText: body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            documentation: { value: "```python\n" + body.replace(/\$\{\d+:?([^}]*)\}/g, "$1").replace(/\$\d/g, "").replace(/\t/g, "    ") + "\n```" },
            detail: doc,
            range,
            sortText: "9" + label,
          })
        }
      }
      return { suggestions }
    },
  })

  monaco.languages.registerSignatureHelpProvider("python", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    async provideSignatureHelp(model, position, token) {
      const sigs = await ask<JediSignature[]>("signature", model, position, token)
      if (!sigs?.length) return null
      return {
        value: {
          signatures: sigs.map((s) => ({
            label: s.label,
            documentation: s.doc ? plain(s.doc) : undefined,
            parameters: s.params.map((p) => ({ label: p })),
          })),
          activeSignature: 0,
          activeParameter: sigs[0].index ?? 0,
        },
        dispose() {},
      }
    },
  })

  monaco.languages.registerHoverProvider("python", {
    async provideHover(model, position, token) {
      if (!model.getWordAtPosition(position)) return null
      const info = await ask<JediHover>("hover", model, position, token)
      if (!info) return null
      return {
        contents: [{ value: "```python\n" + info.header + "\n```" }, ...(info.doc ? [plain(info.doc)] : [])],
      }
    },
  })
}
