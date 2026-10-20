import type * as MonacoApi from "monaco-editor"

/**
 * Python for Monaco: Monaco's own definition, with a tokenizer that tells
 * apart what its stock one lumps together — calls (`print(...)`, `obj.run()`),
 * function and class names, constants, `self`, brackets — so the theme can
 * colour each on its own. Registered here instead of Monaco's lazy loader.
 */

const KEYWORDS = [
  "and", "as", "assert", "async", "await", "break", "case", "class", "continue", "def", "del",
  "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
  "lambda", "match", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
]
const CONSTANTS = ["True", "False", "None", "Ellipsis", "NotImplemented", "__debug__"]
const BUILTIN_TYPES = [
  "int", "float", "complex", "str", "bytes", "bytearray", "bool", "list", "tuple", "dict", "set",
  "frozenset", "object", "type", "range", "slice", "memoryview", "property", "classmethod", "staticmethod",
]

export function registerPython(monaco: typeof MonacoApi) {
  monaco.languages.register({
    id: "python",
    extensions: [".py", ".rpy", ".pyw", ".cpy", ".gyp", ".gypi"],
    aliases: ["Python", "py"],
    firstLine: "^#!/.*\\bpython[0-9.-]*\\b",
  })

  monaco.languages.setLanguageConfiguration("python", {
    comments: { lineComment: "#", blockComment: ["'''", "'''"] },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"', notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string", "comment"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
    ],
    onEnterRules: [
      {
        beforeText: /^\s*(?:def|class|for|if|elif|else|while|try|with|finally|except|async|match|case).*?:\s*$/,
        action: { indentAction: monaco.languages.IndentAction.Indent },
      },
    ],
    folding: { offSide: true, markers: { start: /^\s*#region\b/, end: /^\s*#endregion\b/ } },
  })

  monaco.languages.setMonarchTokensProvider("python", {
    defaultToken: "",
    tokenPostfix: ".python",
    keywords: KEYWORDS,
    constants: CONSTANTS,
    builtinTypes: BUILTIN_TYPES,
    brackets: [
      { open: "{", close: "}", token: "delimiter.curly" },
      { open: "[", close: "]", token: "delimiter.bracket" },
      { open: "(", close: ")", token: "delimiter.parenthesis" },
    ],
    tokenizer: {
      root: [
        { include: "@whitespace" },
        { include: "@numbers" },
        { include: "@strings" },
        [/[,:;]/, "delimiter"],
        [/[{}[\]()]/, "@brackets"],
        [/@[a-zA-Z_][\w.]*/, "tag"],
        // def name / class Name
        [/(def)(\s+)([a-zA-Z_]\w*)/, ["keyword", "white", "function"]],
        [/(class)(\s+)([a-zA-Z_]\w*)/, ["keyword", "white", "type"]],
        [/\bself\b|\bcls\b/, "variable.language"],
        // A name followed by "(" is a call: print(...), obj.method(...), Class(...)
        [
          /[a-zA-Z_]\w*(?=\s*\()/,
          { cases: { "@keywords": "keyword", "@constants": "constant", "[A-Z]\\w*": "type", "@default": "function" } },
        ],
        [/[A-Z][A-Z0-9_]+\b/, "constant"],
        [
          /[a-zA-Z_]\w*/,
          {
            cases: {
              "@keywords": "keyword",
              "@constants": "constant",
              "@builtinTypes": "type",
              "[A-Z]\\w*": "type",
              "@default": "identifier",
            },
          },
        ],
      ],
      whitespace: [
        [/\s+/, "white"],
        [/(#.*$)/, "comment"],
        [/'''/, "string", "@endDocString"],
        [/"""/, "string", "@endDblDocString"],
      ],
      endDocString: [
        [/[^']+/, "string"],
        [/\\'/, "string"],
        [/'''/, "string", "@popall"],
        [/'/, "string"],
      ],
      endDblDocString: [
        [/[^"]+/, "string"],
        [/\\"/, "string"],
        [/"""/, "string", "@popall"],
        [/"/, "string"],
      ],
      numbers: [
        [/-?0x([abcdef]|[ABCDEF]|\d)+[lL]?/, "number.hex"],
        [/-?(\d*\.)?\d+([eE][+-]?\d+)?[jJ]?[lL]?/, "number"],
      ],
      strings: [
        [/'$/, "string.escape", "@popall"],
        [/[fF]'{1,3}/, "string.escape", "@fStringBody"],
        [/'/, "string.escape", "@stringBody"],
        [/"$/, "string.escape", "@popall"],
        [/[fF]"{1,3}/, "string.escape", "@fDblStringBody"],
        [/"/, "string.escape", "@dblStringBody"],
      ],
      fStringBody: [
        [/[^\\'{}]+$/, "string", "@popall"],
        [/[^\\'{}]+/, "string"],
        [/\{[^}':!=]+/, "identifier", "@fStringDetail"],
        [/\\./, "string"],
        [/'/, "string.escape", "@popall"],
        [/\\$/, "string"],
      ],
      stringBody: [
        [/[^\\']+$/, "string", "@popall"],
        [/[^\\']+/, "string"],
        [/\\./, "string"],
        [/'/, "string.escape", "@popall"],
        [/\\$/, "string"],
      ],
      fDblStringBody: [
        [/[^\\"{}]+$/, "string", "@popall"],
        [/[^\\"{}]+/, "string"],
        [/\{[^}':!=]+/, "identifier", "@fStringDetail"],
        [/\\./, "string"],
        [/"/, "string.escape", "@popall"],
        [/\\$/, "string"],
      ],
      dblStringBody: [
        [/[^\\"]+$/, "string", "@popall"],
        [/[^\\"]+/, "string"],
        [/\\./, "string"],
        [/"/, "string.escape", "@popall"],
        [/\\$/, "string"],
      ],
      fStringDetail: [
        [/[:][^}]+/, "string"],
        [/[!][ars]/, "string"],
        [/=/, "string"],
        [/\}/, "identifier", "@pop"],
      ],
    },
  })
}
