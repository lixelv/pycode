import Editor, { type OnMount } from "@monaco-editor/react"
import { useEffect, useRef, useState } from "react"
import { MonacoBinding } from "y-monaco"
import type { Awareness } from "y-protocols/awareness"
import * as Y from "yjs"

import { useI18n } from "@/lib/i18n"
import { registerPythonIntellisense } from "@/lib/intellisense"
import { monaco, type MonacoApi } from "@/lib/monaco"
import { filesOf, languageOf } from "@/lib/project/project"
import { lint, type Diagnostic } from "@/lib/ruff"
import type { Theme } from "@/lib/storage"

registerPythonIntellisense()

export type EditorInstance = MonacoApi.editor.IStandaloneCodeEditor

interface CodeEditorProps {
  /** The project and the file shown; the editor edits that file's Y.Text. */
  doc: Y.Doc
  path: string
  /** Whether the file exists yet (a guest's project arrives after joining). */
  available: boolean
  /** In a live session: everyone's cursors and selections. */
  awareness: Awareness | null
  readOnly: boolean
  theme: Theme
  onText: (text: string) => void
  onDiagnostics: (diagnostics: Diagnostic[]) => void
  onCursor: (line: number, column: number) => void
  onRun: () => void
  onSave: () => void
  onMount: (editor: EditorInstance) => void
}

let modelCounter = 0

export function CodeEditor({
  doc,
  path,
  available,
  awareness,
  readOnly,
  theme,
  onText,
  onDiagnostics,
  onCursor,
  onRun,
  onSave,
  onMount,
}: CodeEditorProps) {
  const { t } = useI18n()
  const [editor, setEditor] = useState<EditorInstance | null>(null)
  const [text, setText] = useState("")
  // Keep the latest callbacks without re-registering Monaco commands.
  const handlers = useRef({ onRun, onCursor, onSave, onText })
  useEffect(() => {
    handlers.current = { onRun, onCursor, onSave, onText }
  }, [onRun, onCursor, onSave, onText])

  // The file's shared text. A reset or an opened archive replaces the Y.Text
  // under the same path: follow it, or the editor would stay bound to the
  // deleted one (and show nothing).
  const [ytext, setYtext] = useState(() => filesOf(doc).get(path))
  useEffect(() => {
    const files = filesOf(doc)
    const read = () => setYtext(files.get(path))
    read()
    files.observe(read)
    return () => files.unobserve(read)
  }, [doc, path])

  // One Monaco model per open file, bound to the file's shared text.
  useEffect(() => {
    if (!editor || !ytext || !available) return
    const model = monaco.editor.createModel("", languageOf(path), monaco.Uri.parse(`file:///${++modelCounter}/${path}`))
    // Bracket colours by depth (the theme defines them); our own models need it set here.
    model.updateOptions({ bracketColorizationOptions: { enabled: true, independentColorPoolPerBracketType: false } })
    editor.setModel(model)
    const empty = editor.createDecorationsCollection()
    const binding = new MonacoBinding(ytext, model, new Set([editor]), awareness)
    // y-monaco publishes the cursor only when it moves: share where it is now,
    // so the others see it from the start (same shape y-monaco uses).
    if (awareness) {
      const sel = editor.getSelection()
      if (sel) {
        let anchor = model.getOffsetAt(sel.getStartPosition())
        let head = model.getOffsetAt(sel.getEndPosition())
        if (sel.getDirection() === monaco.SelectionDirection.RTL) [anchor, head] = [head, anchor]
        awareness.setLocalStateField("selection", {
          anchor: Y.createRelativePositionFromTypeIndex(ytext, anchor),
          head: Y.createRelativePositionFromTypeIndex(ytext, head),
        })
      }
    }
    const report = () => {
      const value = model.getValue()
      setText(value)
      handlers.current.onText(value)
      empty.set(emptyPairs(model))
    }
    report()
    const sub = model.onDidChangeContent(report)
    awareness?.setLocalStateField("file", path)
    return () => {
      sub.dispose()
      empty.clear()
      binding.destroy()
      editor.setModel(null)
      model.dispose()
    }
  }, [editor, ytext, path, available, awareness])

  // Errors: Ruff for Python, the parser for JSON, nothing for other files.
  useEffect(() => {
    let cancelled = false
    const language = languageOf(path)
    const timer = setTimeout(async () => {
      const model = editor?.getModel()
      if (!model) return
      let diagnostics: Diagnostic[] = []
      if (language === "python") diagnostics = await lint(text).catch(() => [])
      else if (language === "json") diagnostics = jsonDiagnostics(text)
      if (cancelled || model.isDisposed()) return
      monaco.editor.setModelMarkers(
        model,
        "lint",
        diagnostics.map((d) => ({
          // Warnings are disabled: everything reported here is an error.
          severity: monaco.MarkerSeverity.Error,
          message: d.message,
          source: language === "python" ? "ruff" : "json",
          code: d.code ?? undefined,
          startLineNumber: d.start_location.row,
          startColumn: d.start_location.column,
          endLineNumber: d.end_location.row,
          endColumn: Math.max(d.end_location.column, d.start_location.row === d.end_location.row ? d.start_location.column + 1 : 0),
        })),
      )
      onDiagnostics(diagnostics)
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [text, path, editor, onDiagnostics])

  const handleMount: OnMount = (instance) => {
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => handlers.current.onRun())
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handlers.current.onSave())
    instance.onDidChangeCursorPosition((e) => handlers.current.onCursor(e.position.lineNumber, e.position.column))
    instance.focus()
    setEditor(instance)
    onMount(instance)
  }

  return (
    <Editor
      theme={theme === "dark" ? "geist-dark" : "geist-light"}
      onMount={handleMount}
      loading={<div className="size-full bg-card" />}
      options={{
        readOnly,
        readOnlyMessage: { value: t("editor.readOnly") },
        fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
        fontSize: 14,
        lineHeight: 22,
        fontLigatures: true,
        minimap: { enabled: false },
        padding: { top: 16, bottom: 16 },
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: "smooth",
        cursorSmoothCaretAnimation: "on",
        renderLineHighlight: "all",
        tabSize: 4,
        insertSpaces: true,
        automaticLayout: true,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        guides: { indentation: true, bracketPairs: false },
        bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: false },
        stickyScroll: { enabled: false },
        fixedOverflowWidgets: true,
        wordWrap: languageOf(path) === "markdown" || languageOf(path) === "plaintext" ? "on" : "off",
        // Suggestions come from Jedi (see lib/intellisense.ts).
        wordBasedSuggestions: "off",
        quickSuggestions: { other: true, comments: false, strings: false },
        quickSuggestionsDelay: 120,
        suggestOnTriggerCharacters: true,
        parameterHints: { enabled: true, cycle: true },
        suggest: { showWords: false, preview: true, showStatusBar: true, insertMode: "replace" },
        hover: { delay: 400 },
      }}
    />
  )
}

/**
 * An empty pair — `()`, `[]`, `{}` — stays grey whatever its depth. Pairs
 * inside strings or comments are skipped (a quote-count check per line).
 */
function emptyPairs(model: MonacoApi.editor.ITextModel): MonacoApi.editor.IModelDeltaDecoration[] {
  const out: MonacoApi.editor.IModelDeltaDecoration[] = []
  const lines = model.getLineCount()
  for (let line = 1; line <= lines; line++) {
    const text = model.getLineContent(line)
    if (!/\(\)|\[\]|\{\}/.test(text)) continue
    const re = /\(\)|\[\]|\{\}/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      const before = text.slice(0, m.index)
      if (before.includes("#") || (before.split('"').length - 1) % 2 || (before.split("'").length - 1) % 2) continue
      out.push({
        range: new monaco.Range(line, m.index + 1, line, m.index + 3),
        options: { inlineClassName: "bracket-empty" },
      })
    }
  }
  return out
}

/** A JSON syntax error as a diagnostic (V8 reports "... at position N"). */
function jsonDiagnostics(text: string): Diagnostic[] {
  if (!text.trim()) return []
  try {
    JSON.parse(text)
    return []
  } catch (err) {
    const message = (err as Error).message
    const pos = Number(/position (\d+)/.exec(message)?.[1] ?? text.length)
    const before = text.slice(0, pos)
    const row = before.split("\n").length
    const column = pos - before.lastIndexOf("\n")
    const loc = { row, column }
    return [
      {
        code: null,
        message: message.replace(/^JSON\.parse: /, ""),
        start_location: loc,
        end_location: { row, column: column + 1 },
      } as unknown as Diagnostic,
    ]
  }
}
