import { loader } from "@monaco-editor/react"
import EditorWorker from "monaco-esm/editor/editor.worker.js?worker"
import CssWorker from "monaco-esm/language/css/css.worker.js?worker"
import HtmlWorker from "monaco-esm/language/html/html.worker.js?worker"
import TsWorker from "monaco-esm/language/typescript/ts.worker.js?worker"
import type * as MonacoApi from "monaco-editor"

import * as core from "./monaco-core"
import { registerPython } from "./python-language"

// The slim build exposes the same API as the full package; borrow its types.
const monaco = core as unknown as typeof MonacoApi
registerPython(monaco)

// Bundle Monaco locally instead of loading it from a CDN.
// Each web language has its own worker (started the first time such a file opens).
self.MonacoEnvironment = {
  getWorker: (_: string, label: string) => {
    if (label === "css" || label === "scss" || label === "less") return new CssWorker()
    if (label === "html") return new HtmlWorker()
    if (label === "javascript" || label === "typescript") return new TsWorker()
    return new EditorWorker()
  },
}
loader.config({ monaco })

// JSON: highlighting only (VS Code's own JSON language server is not needed
// for learning; syntax errors are reported by the editor component).
monaco.languages.register({ id: "json", extensions: [".json"], aliases: ["JSON"] })
monaco.languages.setMonarchTokensProvider("json", {
  tokenizer: {
    root: [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "type"],
      [/"(?:[^"\\]|\\.)*"/, "string"],
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/, "number"],
      [/\b(?:true|false|null)\b/, "keyword"],
      [/[{}[\],:]/, "delimiter"],
    ],
  },
})
monaco.languages.setLanguageConfiguration("json", {
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}" },
    { open: "[", close: "]" },
    { open: '"', close: '"', notIn: ["string"] },
  ],
})

// Geist syntax colours (provisional, mirrors vercel.com code blocks).
monaco.editor.defineTheme("geist-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "", foreground: "ededed" },
    { token: "comment", foreground: "8f8f8f", fontStyle: "italic" },
    { token: "keyword", foreground: "f75f8f" },
    { token: "string", foreground: "62c073" },
    { token: "number", foreground: "52a8ff" },
    { token: "constant", foreground: "52a8ff" },
    { token: "type", foreground: "bf7af0" },
    { token: "function", foreground: "bf7af0" },
    { token: "variable.language", foreground: "ededed" },
    { token: "identifier", foreground: "ededed" },
    { token: "delimiter", foreground: "a1a1a1" },
    // Brackets are quiet grey, not a colour of their own.
    { token: "delimiter.parenthesis", foreground: "8f8f8f" },
    { token: "delimiter.bracket", foreground: "8f8f8f" },
    { token: "delimiter.curly", foreground: "8f8f8f" },
    { token: "tag", foreground: "bf7af0" },
  ],
  colors: {
    "editor.background": "#0a0a0a",
    "editor.foreground": "#ededed",
    "editorLineNumber.foreground": "#454545",
    "editorLineNumber.activeForeground": "#ededed",
    "editor.lineHighlightBackground": "#ffffff08",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#3291ff40",
    "editor.inactiveSelectionBackground": "#3291ff20",
    "editorCursor.foreground": "#ededed",
    "editorIndentGuide.background1": "#1f1f1f",
    "editorIndentGuide.activeBackground1": "#333333",
    "editorWidget.background": "#0a0a0a",
    "editorWidget.border": "#242424",
    "editorHoverWidget.background": "#0a0a0a",
    "editorHoverWidget.border": "#242424",
    "editorSuggestWidget.background": "#0a0a0a",
    "editorSuggestWidget.border": "#242424",
    "editorSuggestWidget.selectedBackground": "#1f1f1f",
    "editorError.foreground": "#ff6166",
    // Brackets by depth: outermost grey, then yellow, purple, blue (and around again).
    "editorBracketHighlight.foreground1": "#8f8f8f",
    "editorBracketHighlight.foreground2": "#f5d90a",
    "editorBracketHighlight.foreground3": "#bf7af0",
    "editorBracketHighlight.foreground4": "#52a8ff",
    "editorBracketHighlight.foreground5": "#f5d90a",
    "editorBracketHighlight.foreground6": "#bf7af0",
    "editorBracketHighlight.unexpectedBracket.foreground": "#ff6166",
    "scrollbarSlider.background": "#ffffff14",
    "scrollbarSlider.hoverBackground": "#ffffff24",
    "editorGutter.background": "#0a0a0a",
  },
})

monaco.editor.defineTheme("geist-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "", foreground: "171717" },
    { token: "comment", foreground: "666666", fontStyle: "italic" },
    { token: "keyword", foreground: "c41562" },
    { token: "string", foreground: "297c3b" },
    { token: "number", foreground: "0068d6" },
    { token: "constant", foreground: "0068d6" },
    { token: "type", foreground: "8e4ec6" },
    { token: "function", foreground: "8e4ec6" },
    { token: "variable.language", foreground: "171717" },
    { token: "delimiter", foreground: "666666" },
    { token: "delimiter.parenthesis", foreground: "8f8f8f" },
    { token: "delimiter.bracket", foreground: "8f8f8f" },
    { token: "delimiter.curly", foreground: "8f8f8f" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#171717",
    "editorLineNumber.foreground": "#c9c9c9",
    "editorLineNumber.activeForeground": "#171717",
    "editor.lineHighlightBackground": "#0000000a",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#0070f330",
    "editorCursor.foreground": "#171717",
    "editorWidget.border": "#eaeaea",
    "editorError.foreground": "#da2f35",
    "editorBracketHighlight.foreground1": "#8f8f8f",
    "editorBracketHighlight.foreground2": "#a37b00",
    "editorBracketHighlight.foreground3": "#8e4ec6",
    "editorBracketHighlight.foreground4": "#0068d6",
    "editorBracketHighlight.foreground5": "#a37b00",
    "editorBracketHighlight.foreground6": "#8e4ec6",
    "editorBracketHighlight.unexpectedBracket.foreground": "#da2f35",
    "editorGutter.background": "#ffffff",
  },
})

export { monaco }
export type { MonacoApi }
