import { HTMLHint } from "htmlhint"

export interface Problem {
  line: number
  col: number
  message: string
  rule: string
}

// Mistakes that break a page; style rules (lowercase, quotes, …) are left out.
const RULES = {
  "tag-pair": true,
  "attr-no-duplication": true,
  "id-unique": true,
  "src-not-empty": true,
  "attr-unsafe-chars": true,
  "spec-char-escape": false,
}

/** Errors in an HTML page (HTMLHint). */
export function htmlProblems(html: string): Problem[] {
  return HTMLHint.verify(html, RULES).map((m) => ({ line: m.line, col: m.col, message: m.message, rule: m.rule.id }))
}
