import init, { PositionEncoding, Workspace, type Diagnostic } from "@astral-sh/ruff-wasm-web"

export type { Diagnostic }

/**
 * Only rules that point at real errors are enabled — no style or "warning"
 * rules: syntax errors (E9), invalid comparisons/prints (F63), statements in
 * the wrong place (F7) and undefined names (F82).
 */
const SETTINGS = {
  "line-length": 100,
  lint: { select: ["E9", "F63", "F7", "F82"] },
  format: { "quote-style": "double" },
}

let workspace: Promise<Workspace> | null = null

export function getRuff(): Promise<Workspace> {
  workspace ??= init().then(() => new Workspace(SETTINGS, PositionEncoding.Utf16))
  return workspace
}

export async function lint(code: string): Promise<Diagnostic[]> {
  const ruff = await getRuff()
  return ruff.check(code) as Diagnostic[]
}

export async function format(code: string): Promise<string> {
  const ruff = await getRuff()
  return ruff.format(code)
}

export const ruffVersion = () => getRuff().then(() => Workspace.version())
