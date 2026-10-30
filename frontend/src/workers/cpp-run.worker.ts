/// <reference lib="webworker" />
// Runs a compiled C++ program (WASI). The program is synchronous WebAssembly:
// the page stops it by terminating this worker (CppRunnerClient.interrupt).
// It sees only the shim's imports: no network, files under /project only.
import { runWasm, Stdin, Utf8Out } from "@/lib/cpp/wasi"
import { BATCH_HEADER_BYTES, type CppRunRequest, type RunnerEvent } from "@/workers/protocol"

const post = (event: RunnerEvent) => postMessage(event)

/** A check's run: fixed input, then EOF; the output and the numbers go into the shared result. */
async function batch(msg: Extract<CppRunRequest, { type: "batch" }>) {
  const header = new Int32Array(msg.result, 0, 4)
  const output = new Uint8Array(msg.result, BATCH_HEADER_BYTES)
  let length = 0
  const write = (kind: "stdout" | "stderr", bytes: Uint8Array) => {
    if (kind !== "stdout") return
    output.set(bytes, length) // fits: runWasm stops the program at MAX_OUTPUT_BYTES
    length += bytes.length
  }
  let memory = 0
  let code = 1
  try {
    ;({ memory, code } = await runWasm(msg.wasm, msg.files, msg.cwd, new Stdin(msg.stdin), write))
  } catch {
    // Reported as exit code 1: the tests see the output so far.
  }
  header[1] = length
  header[2] = memory
  header[3] = code
  Atomics.store(header, 0, 1)
  Atomics.notify(header, 0)
  close()
}

onmessage = async ({ data: msg }: MessageEvent<CppRunRequest>) => {
  if (msg.type === "batch") return batch(msg)
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
