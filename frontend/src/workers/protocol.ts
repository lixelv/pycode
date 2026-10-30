/** A project to run: path -> text, or bytes for a binary file. */
export type ProjectFiles = Record<string, string | Uint8Array>

export interface InstallResult {
  spec: string
  name?: string
  version?: string
  error?: string
}

// ---- runner worker --------------------------------------------------------

/** Shared memory between the page and the runner worker. */
export interface RunnerBuffers {
  /** [0] stdin state (STDIN_*), [1] byte length of the line in `data`. */
  control: SharedArrayBuffer
  /** UTF-8 bytes of the line the user typed. */
  data: SharedArrayBuffer
  /** Pyodide's interrupt buffer: writing 2 (SIGINT) raises KeyboardInterrupt. */
  interrupt: SharedArrayBuffer
}

export const STDIN_WAITING = 0
export const STDIN_READY = 1
export const STDIN_EOF = 2
export const STDIN_INTERRUPT = 3
export const STDIN_MAX_BYTES = 64 * 1024

export type RunnerRequest =
  | { type: "init"; buffers: RunnerBuffers }
  | { type: "install"; id: number; specs: string[] }
  | { type: "run"; id: number; files: ProjectFiles; entry: string; specs: string[] }
  | { type: "check"; id: number; files: ProjectFiles; solution: string; test: string; specs: string[] }

export type RunnerEvent =
  | { type: "ready"; python: string }
  | { type: "boot-error"; message: string }
  | { type: "status"; text: string }
  | { type: "stdout" | "stderr"; data: string }
  | { type: "input_request" }
  | { type: "installed"; id: number; results: InstallResult[] }
  | { type: "exit"; id: number; code: number; duration: number; reason: "output_limit" | null }
  | { type: "checked"; id: number; results: CheckResult[] }

/** One test of an automatic check (python/checker.py). */
export interface CheckResult {
  name: string
  ok: boolean
  message: string
}

// ---- tools worker ---------------------------------------------------------

export type ToolKind = "flow" | "ast" | "complete" | "signature" | "hover" | "install"

export interface ToolRequest {
  id: number
  kind: ToolKind
  code?: string
  line?: number
  column?: number
  specs?: string[]
  /** Interface language for generated text (flowchart captions). */
  lang?: string
}

export type ToolResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string }
