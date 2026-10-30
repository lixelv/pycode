/// <reference lib="webworker" />
// Runs a compiled C++ program (WASI). The program is synchronous WebAssembly:
// the page stops it by terminating this worker (CppRunnerClient.interrupt).
// It sees only the shim's imports: no network, files under /project only.
import { runWasm, Stdin, Utf8Out } from "@/lib/cpp/wasi"
import type { CppRunRequest, RunnerEvent } from "@/workers/protocol"

const post = (event: RunnerEvent) => postMessage(event)

onmessage = async ({ data: msg }: MessageEvent<CppRunRequest>) => {
  if (msg.type !== "run") return // batch (checks) comes with Task 12
  // Every write is posted at once: the program is synchronous, so nothing here
  // could send held text later, and Stop terminates this worker. The page batches.
  const decoders = { stdout: new Utf8Out(), stderr: new Utf8Out() }
  const send = (type: "stdout" | "stderr", data: string) => {
    if (data) post({ type, data })
  }
  const write = (kind: "stdout" | "stderr", bytes: Uint8Array) => send(kind, decoders[kind].push(bytes))
  const stdin = new Stdin({
    control: new Int32Array(msg.buffers.control),
    data: new Uint8Array(msg.buffers.data),
    waiting: () => post({ type: "input_request" }),
  })
  const started = performance.now()
  let code = 1
  let reason: "output_limit" | null = null
  try {
    const result = await runWasm(msg.wasm, msg.files, msg.cwd, stdin, write)
    code = result.code
    if (result.outputLimited) reason = "output_limit"
  } catch (err) {
    send("stderr", `\n${err instanceof Error ? err.message : String(err)}\n`)
  }
  // At the output limit a letter left unfinished by an earlier write is dropped, not shown as U+FFFD.
  if (!reason) for (const kind of ["stdout", "stderr"] as const) send(kind, decoders[kind].flush())
  post({ type: "exit", id: msg.id, code, duration: (performance.now() - started) / 1000, reason })
}
