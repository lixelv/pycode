/// <reference lib="webworker" />
// Runs a compiled C++ program (WASI). The program is synchronous WebAssembly:
// the page stops it by terminating this worker (CppRunnerClient.interrupt).
// It sees only the shim's imports: no network, files under /project only.
import { runWasm, Stdin, Utf8Out } from "@/lib/cpp/wasi"
import type { CppRunRequest, RunnerEvent } from "@/workers/protocol"

const post = (event: RunnerEvent) => postMessage(event)

/** Coalesces writes into few messages, keeping stdout and stderr in order. */
class Output {
  private decoders = { stdout: new Utf8Out(), stderr: new Utf8Out() }
  private kind: "stdout" | "stderr" = "stdout"
  private pending = ""
  private last = 0

  write(kind: "stdout" | "stderr", bytes: Uint8Array) {
    if (kind !== this.kind) this.flush()
    this.kind = kind
    this.pending += this.decoders[kind].push(bytes)
    if (this.pending.length > 4096 || performance.now() - this.last > 16) this.flush()
  }

  flush() {
    if (this.pending) post({ type: this.kind, data: this.pending })
    this.pending = ""
    this.last = performance.now()
  }

  end() {
    for (const kind of ["stdout", "stderr"] as const) {
      this.flush()
      this.kind = kind
      this.pending = this.decoders[kind].flush()
    }
    this.flush()
  }
}

onmessage = async ({ data: msg }: MessageEvent<CppRunRequest>) => {
  if (msg.type !== "run") return // batch (checks) comes with Task 12
  const output = new Output()
  const stdin = new Stdin({
    control: new Int32Array(msg.buffers.control),
    data: new Uint8Array(msg.buffers.data),
    waiting: () => {
      output.flush() // the prompt before the input line
      post({ type: "input_request" })
    },
  })
  const started = performance.now()
  let code = 1
  let reason: "output_limit" | null = null
  try {
    const result = await runWasm(msg.wasm, msg.files, msg.cwd, stdin, (kind, bytes) => output.write(kind, bytes))
    code = result.code
    if (result.outputLimited) reason = "output_limit"
  } catch (err) {
    output.write("stderr", new TextEncoder().encode(`\n${err instanceof Error ? err.message : String(err)}\n`))
  }
  output.end()
  post({ type: "exit", id: msg.id, code, duration: (performance.now() - started) / 1000, reason })
}
