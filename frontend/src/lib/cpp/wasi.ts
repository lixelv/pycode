// Running a compiled C++ program (WASI preview1) with @bjorn3/browser_wasi_shim.
// Shared by cpp-run.worker's modes: `run` (interactive console) and `batch` (checks).
import { ConsoleStdout, Directory, Fd, File, PreopenDirectory, WASI, wasi, type Inode } from "@bjorn3/browser_wasi_shim"

import { STDIN_EOF, STDIN_WAITING, type ProjectFiles } from "@/workers/protocol"

export const MAX_OUTPUT_BYTES = 1_000_000

/** Decodes a program's output in pieces: a letter split between two writes comes out whole. */
export class Utf8Out {
  private decoder = new TextDecoder()

  push(bytes: Uint8Array): string {
    return this.decoder.decode(bytes, { stream: true })
  }

  /** What is left (an unfinished letter becomes U+FFFD). */
  flush(): string {
    return this.decoder.decode()
  }
}

/** The program's working folder: the entry's folder under /project. */
export function cwdOf(entry: string) {
  const dir = entry.split("/").slice(0, -1).join("/")
  return dir ? `/project/${dir}` : "/project"
}

/** `{"sub/data.txt": "…"}` → the tree under the preopened /project. */
export function projectTree(files: ProjectFiles): Map<string, Inode> {
  const root = new Map<string, Inode>()
  const encoder = new TextEncoder()
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/")
    let dir = root
    for (const part of parts.slice(0, -1)) {
      let next = dir.get(part)
      if (!(next instanceof Directory)) dir.set(part, (next = new Directory(new Map())))
      dir = (next as Directory).contents
    }
    dir.set(parts[parts.length - 1], new File(typeof content === "string" ? encoder.encode(content) : content))
  }
  return root
}

/** Interactive input: the page's RunnerBuffers, the same protocol as Python's input(). */
export interface InteractiveInput {
  control: Int32Array
  data: Uint8Array
  /** Called before the program blocks (flush the output, ask the page for a line). */
  waiting: () => void
}

/** stdin: blocks for a line from the page, or reads a fixed text (batch) and then EOF. */
export class Stdin extends Fd {
  private pending: Uint8Array
  private source: InteractiveInput | null

  constructor(source: InteractiveInput | string) {
    super()
    this.source = typeof source === "string" ? null : source
    this.pending = typeof source === "string" ? new TextEncoder().encode(source) : new Uint8Array()
  }

  fd_fdstat_get() {
    return { ret: 0, fdstat: new wasi.Fdstat(wasi.FILETYPE_CHARACTER_DEVICE, 0) }
  }

  fd_read(size: number) {
    if (!this.pending.length && this.source) {
      const { control, data, waiting } = this.source
      Atomics.store(control, 0, STDIN_WAITING)
      waiting()
      Atomics.wait(control, 0, STDIN_WAITING)
      // EOF (Ctrl+D) answers this one read with nothing; the next read waits again, like a terminal.
      if (Atomics.load(control, 0) !== STDIN_EOF) this.pending = data.slice(0, Atomics.load(control, 1))
    }
    const chunk = this.pending.slice(0, size)
    this.pending = this.pending.slice(chunk.length)
    return { ret: 0, data: chunk }
  }
}

class OutputLimit extends Error {}

export interface WasmResult {
  /** proc_exit's code, 0, 134 for a trap (abort, an uncaught `throw`), 130 when cut at the output limit. */
  code: number
  outputLimited: boolean
  /** Linear memory at the end, in bytes (the program's peak). */
  memory: number
}

/**
 * Runs the program to the end. stdout and stderr together may write
 * MAX_OUTPUT_BYTES; past that the program is stopped.
 */
export async function runWasm(
  wasm: Uint8Array,
  files: ProjectFiles,
  cwd: string,
  stdin: Fd,
  write: (kind: "stdout" | "stderr", bytes: Uint8Array) => void,
): Promise<WasmResult> {
  let left = MAX_OUTPUT_BYTES
  let outputLimited = false
  const output = (kind: "stdout" | "stderr") =>
    new ConsoleStdout((bytes) => {
      const part = bytes.subarray(0, left)
      left -= part.length
      if (part.length) write(kind, part)
      if (part.length < bytes.length) {
        outputLimited = true
        throw new OutputLimit()
      }
    })
  const fds = [stdin, output("stdout"), output("stderr"), new PreopenDirectory("/project", projectTree(files))]
  // stub.o (linked into every program) changes into POLYCODE_CWD: wasi-libc starts in "/".
  const shim = new WASI(["a.out"], [`PWD=${cwd}`, `POLYCODE_CWD=${cwd}`], fds, { debug: false })
  const module = await WebAssembly.compile(wasm as Uint8Array<ArrayBuffer>)
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: shim.wasiImport })
  let code: number
  try {
    code = shim.start(instance as { exports: { memory: WebAssembly.Memory; _start: () => unknown } })
  } catch (err) {
    if (err instanceof OutputLimit) code = 130
    else {
      // abort() is the trap `unreachable` and prints its own message; other traps say what happened.
      if (!/unreachable/i.test(String(err))) write("stderr", new TextEncoder().encode(`\n${err instanceof Error ? err.message : String(err)}\n`))
      code = 134
    }
  }
  return { code, outputLimited, memory: (instance.exports.memory as WebAssembly.Memory).buffer.byteLength }
}
