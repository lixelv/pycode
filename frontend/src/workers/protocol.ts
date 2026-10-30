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
  /** [0] stdin state (STDIN_*), [1] byte length of the line in `data`, [2] the check's time limit (DEADLINE_SLOT). */
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
// The debugger waits on the same slot: [0] DEBUG_WAITING until the page sets DEBUG_GO with the command in [1].
export const DEBUG_WAITING = 4
export const DEBUG_GO = 5
export const DEBUG_COMMANDS = ["continue", "next", "step", "return", "stop"] as const
export type DebugCommand = (typeof DEBUG_COMMANDS)[number]

/** Where a debugged program stopped (python/debugger.py). */
export interface DebugState {
  file: string
  line: number
  stack: { name: string; file: string; line: number }[]
  vars: Record<string, string>
}

export type RunnerRequest =
  | { type: "init"; buffers: RunnerBuffers }
  | { type: "install"; id: number; specs: string[] }
  | { type: "run"; id: number; files: ProjectFiles; entry: string; specs: string[]; breakpoints?: Record<string, number[]> }
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
  /** The debugged program stopped (state) or goes on (null). */
  | { type: "paused"; state: DebugState | null }
  /** polycode_test.run(timeout=…): interrupt the program after ms if timer gen is still armed (lib/python/deadline.ts). */
  | { type: "deadline"; ms: number; gen: number }

/** A client that runs one program at a time in the console (Python's RunnerClient, CppRunnerClient). */
export interface ProgramRunner {
  on(listener: (event: RunnerEvent) => void): () => void
  sendLine(text: string): void
  sendEof(): void
  /** Stops the program; it ends with an `exit` event (or is replaced, see use-runner). */
  interrupt(): void
  /** Throws the program away without an `exit` event. */
  restart(): void
}

// ---- C++ run worker (cpp-run.worker.ts) -----------------------------------

/**
 * `run`: interactive, events like the Python runner's (stdout/stderr/input_request/exit).
 * `batch`: for checks, input is a fixed text and the result goes into `result` (Task 12).
 * `cwd` is the program's folder in the virtual FS (`/project/<entry folder>`).
 */
export type CppRunRequest =
  | { type: "run"; id: number; wasm: Uint8Array; files: ProjectFiles; cwd: string; buffers: RunnerBuffers }
  | { type: "batch"; wasm: Uint8Array; files: ProjectFiles; cwd: string; stdin: string; result: SharedArrayBuffer }

/** One test of an automatic check (python/checker.py). */
export interface CheckResult {
  name: string
  ok: boolean
  message: string
  /** Seconds the test's run(timeout=…) calls took, summed. */
  time?: number
  /** Peak bytes of the test's run(ram_usage=…) calls. */
  memory?: number
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
