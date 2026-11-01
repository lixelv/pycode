import Editor, { type OnMount } from "@monaco-editor/react"
import { useEffect, useRef, useState } from "react"
import { MonacoBinding } from "y-monaco"
import type { Awareness } from "y-protocols/awareness"
import * as Y from "yjs"

import { useI18n } from "@/lib/i18n"
import { registerPythonIntellisense } from "@/lib/intellisense"
import type { ClangDiagnostic } from "@/lib/cpp/diagnostics"
import { byteColumn, wantsCompletion, type CppCompletion } from "@/lib/cpp/completion"
import { monaco, type MonacoApi } from "@/lib/monaco"
import { languageOf, metasOf, textOf } from "@/lib/project/project"
import type { ProjectStore } from "@/lib/project/store"
import { lint, type Diagnostic } from "@/lib/ruff"
import { htmlProblems } from "@/lib/web-lint"
import type { Theme } from "@/lib/storage"

registerPythonIntellisense()

export type EditorInstance = MonacoApi.editor.IStandaloneCodeEditor

interface CodeEditorProps {
  /** The project and the file shown; the editor edits that file's Y.Text. */
  store: ProjectStore
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
  /** Python only: breakpoint lines (click the gutter to toggle) and where the debugger stopped. */
  breakpoints?: number[]
  onToggleBreakpoint?: (line: number) => void
  debugLine?: number | null
  /** C++ only: clang's problems for the file's text (see lib/cpp/client.ts). */
  lintCpp?: (text: string) => Promise<ClangDiagnostic[]>
  /** Suggestions at a position (clang's line and byte column). */
  completeCpp?: (text: string, line: number, column: number) => Promise<CppCompletion[]>
}

let modelCounter = 0

const SOURCE: Partial<Record<string, string>> = { python: "ruff", cpp: "clang", html: "htmlhint" }

export function CodeEditor({
  store,
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
  breakpoints,
  onToggleBreakpoint,
  debugLine,
  lintCpp,
  completeCpp,
}: CodeEditorProps) {
  const { t } = useI18n()
  const [editor, setEditor] = useState<EditorInstance | null>(null)
  const [text, setText] = useState("")
  // Keep the latest callbacks without re-registering Monaco commands.
  const handlers = useRef({ onRun, onCursor, onSave, onText, onToggleBreakpoint })
  // The provider is global to the language: it stands only while a C++ file is open here.
  useEffect(() => {
    if (!completeCpp || !editor) return
    const KIND = { function: monaco.languages.CompletionItemKind.Function, variable: monaco.languages.CompletionItemKind.Variable, type: monaco.languages.CompletionItemKind.Class, keyword: monaco.languages.CompletionItemKind.Keyword }
    const provider = monaco.languages.registerCompletionItemProvider("cpp", {
      triggerCharacters: [".", ">", ":"],
      async provideCompletionItems(model, position, context, token) {
        if (model !== editor.getModel()) return { suggestions: [] }
        const before = model.getLineContent(position.lineNumber).slice(0, position.column - 1)
        if (!wantsCompletion(before, context.triggerCharacter)) return { suggestions: [] }
        const word = model.getWordUntilPosition(position)
        const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
        const list = await completeCpp(model.getValue(), position.lineNumber, byteColumn(before, word.startColumn)).catch(() => [])
        if (token.isCancellationRequested) return { suggestions: [] }
        return {
          suggestions: list.map((c) => ({
            label: c.name,
            kind: KIND[c.kind],
            detail: c.overloads ? `${c.detail} (+${c.overloads})` : c.detail,
            insertText: c.snippet,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range,
          })),
        }
      },
    })
    return () => provider.dispose()
  }, [completeCpp, editor])

  useEffect(() => {
    handlers.current = { onRun, onCursor, onSave, onText, onToggleBreakpoint }
  }, [onRun, onCursor, onSave, onText, onToggleBreakpoint])

  // Breakpoints (red dots in the gutter) and the line the debugger stopped on.
  useEffect(() => {
    if (!editor) return
    const marks = editor.createDecorationsCollection()
    const apply = () => {
      if (!editor.getModel()) return
      marks.set([
        ...(breakpoints ?? []).map((line) => ({
          range: new monaco.Range(line, 1, line, 1),
          options: { glyphMarginClassName: "bp-glyph", glyphMarginHoverMessage: { value: t("debug.breakpoint") } },
        })),
        ...(debugLine
          ? [{ range: new monaco.Range(debugLine, 1, debugLine, 1), options: { isWholeLine: true, className: "debug-line", glyphMarginClassName: "debug-arrow" } }]
          : []),
      ])
      if (debugLine) editor.revealLineInCenterIfOutsideViewport(debugLine)
    }
    apply()
    // Each file has its own model: put the marks back when it changes.
    const sub = editor.onDidChangeModel(apply)
    return () => {
      sub.dispose()
      marks.clear()
    }
  }, [editor, breakpoints, debugLine, t])

  // The file's shared text. A reset or an opened archive puts a new file
  // (a new document) under the same path: follow it, or the editor would
  // stay bound to the deleted one (and show nothing).
  const [ytext, setYtext] = useState(() => textOf(store, path))
  useEffect(() => {
    const metas = metasOf(store)
    const read = () => setYtext(textOf(store, path))
    read()
    metas.observe(read)
    return () => metas.unobserve(read)
  }, [store, path])

  // One Monaco model per open file, bound to the file's shared text.
  useEffect(() => {
    if (!editor || !ytext || !available) return
    const model = monaco.editor.createModel("", languageOf(path), monaco.Uri.parse(`file:///${++modelCounter}/${path}`))
    // Bracket colours by depth (the theme defines them); our own models need it set here.
    model.updateOptions({
      bracketColorizationOptions: { enabled: true, independentColorPoolPerBracketType: false },
      // Python uses 4 spaces; web files are usually indented by 2.
      tabSize: languageOf(path) === "python" ? 4 : 2,
    })
    editor.setModel(model)
    const empty = editor.createDecorationsCollection()
    // Every file's text is the root type "t" of its own document, so a relative
    // position from another file would resolve here too: show only the cursors of
    // members who are in this file.
    awareness?.setLocalStateField("file", path)
    const here = awareness && new Proxy(awareness, {
      get(target, prop) {
        if (prop === "getStates") return () => new Map([...target.getStates()].filter(([, state]) => state.file === path))
        const value = Reflect.get(target, prop)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const binding = new MonacoBinding(ytext, model, new Set([editor]), here)
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
    return () => {
      sub.dispose()
      empty.clear()
      binding.destroy()
      editor.setModel(null)
      model.dispose()
    }
  }, [editor, ytext, path, available, awareness])

  // Errors: Ruff for Python, clang for C++, the parser for JSON, nothing for other files.
  useEffect(() => {
    let cancelled = false
    const language = languageOf(path)
    const timer = setTimeout(async () => {
      const model = editor?.getModel()
      if (!model) return
      let diagnostics: Diagnostic[] = []
      // Clang reports warnings too; everything else here is an error.
      let warnings = new Set<Diagnostic>()
      if (language === "python") diagnostics = await lint(text).catch(() => [])
      else if (language === "cpp") {
        if (!lintCpp) return
        const found = await lintCpp(text).catch(() => [])
        diagnostics = found.map((d) => diagnostic(d.line, d.col, d.message, null))
        warnings = new Set(diagnostics.filter((_, i) => found[i].severity === "warning"))
      }
      else if (language === "json") diagnostics = jsonDiagnostics(text)
      else if (language === "html") diagnostics = htmlProblems(text).map((p) => diagnostic(p.line, p.col, p.message, p.rule))
      // CSS and JavaScript are checked by Monaco's own workers (see below).
      else if (language === "css" || language === "javascript") return
      if (cancelled || model.isDisposed()) return
      monaco.editor.setModelMarkers(
        model,
        "lint",
        diagnostics.map((d) => ({
          severity: warnings.has(d) ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
          message: d.message,
          source: SOURCE[language] ?? "json",
          code: d.code ?? undefined,
          startLineNumber: d.start_location.row,
          startColumn: d.start_location.column,
          endLineNumber: d.end_location.row,
          endColumn: Math.max(d.end_location.column, d.start_location.row === d.end_location.row ? d.start_location.column + 1 : 0),
        })),
      )
      // The footer counts errors only.
      onDiagnostics(diagnostics.filter((d) => !warnings.has(d)))
    }, language === "cpp" ? 500 : 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [text, path, editor, onDiagnostics, lintCpp])

  // CSS and JavaScript: Monaco's language workers set their own markers; report their errors.
  useEffect(() => {
    const language = languageOf(path)
    if (!editor || (language !== "css" && language !== "javascript")) return
    const report = () => {
      const model = editor.getModel()
      if (!model) return
      const errors = monaco.editor.getModelMarkers({ resource: model.uri }).filter((m) => m.severity === monaco.MarkerSeverity.Error)
      onDiagnostics(errors.map((m) => diagnostic(m.startLineNumber, m.startColumn, m.message, null)))
    }
    report()
    const sub = monaco.editor.onDidChangeMarkers(report)
    return () => sub.dispose()
  }, [editor, path, text, onDiagnostics])

  const handleMount: OnMount = (instance) => {
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => handlers.current.onRun())
    instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => handlers.current.onSave())
    instance.onDidChangeCursorPosition((e) => handlers.current.onCursor(e.position.lineNumber, e.position.column))
    instance.onMouseDown((e) => {
      const kind = e.target.type
      if (kind !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && kind !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS) return
      if (e.target.position) handlers.current.onToggleBreakpoint?.(e.target.position.lineNumber)
    })
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
        // Monaco hides problems in a read-only editor by default; a student who only reads sees them too.
        renderValidationDecorations: "on",
        fontFamily: "'Geist Mono Variable', ui-monospace, monospace",
        fontSize: 14,
        lineHeight: 22,
        fontLigatures: true,
        minimap: { enabled: false },
        glyphMargin: languageOf(path) === "python",
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

/** A problem at one place, in Ruff's diagnostic shape (what the footer counts). */
function diagnostic(row: number, column: number, message: string, code: string | null): Diagnostic {
  return { code, message, start_location: { row, column }, end_location: { row, column: column + 1 } } as unknown as Diagnostic
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
