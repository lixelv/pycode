/// <reference lib="webworker" />
// Clang (@yowasp/clang, LLVM built for WebAssembly): checks and compiles C++.
// The project lies under /project, packages under /packages; paths in the
// log are made relative to the project.
import { commands, Exit, type Tree } from "@yowasp/clang"

import stubSrc from "@/cpp/stub.cpp?raw"
import { clangInput, clangTree } from "@/lib/cpp/clang-files"
import type { CppRequest, CppResponse } from "@/lib/cpp/client"

const clang = commands["clang++"]
const STD = ["-std=c++20", "-fno-color-diagnostics"]

// Fetches and compiles the toolchain (105 MB) once; every later call reuses
// it. A failed download is reported and tried again on the next request.
let prefetch: Promise<void> | null = null
function ready() {
  prefetch ??= Promise.resolve(clang(undefined, {}, { fetchProgress: () => {} })).then(
    () => postMessage({ ready: true }),
    (err: unknown) => {
      prefetch = null
      postMessage({ ready: false })
      throw err
    },
  )
  return prefetch
}
void ready().catch(() => {})

let stub: Promise<Uint8Array> | null = null

/** Runs clang++; resolves with its log and the files it left (inputs plus outputs). */
async function run(args: string[], files: Tree): Promise<{ log: string; out: Tree | null }> {
  await ready()
  let log = ""
  const decoder = new TextDecoder()
  const collect = (bytes: Uint8Array | null) => {
    if (bytes) log += decoder.decode(bytes, { stream: true })
  }
  try {
    const out = (await clang(args, files, { stdout: collect, stderr: collect, decodeASCII: false })) as Tree
    return { log, out }
  } catch (err) {
    if (err instanceof Exit) return { log, out: null }
    throw err
  }
}

/** Exceptions and the working folder for every program (see stub.cpp). */
function stubObject() {
  if (!stub) {
    stub = run([...STD, "-O1", "-c", "/stub.cpp", "-o", "/stub.o"], { "stub.cpp": stubSrc }).then(({ log, out }) => {
      if (!out) throw new Error(log)
      return out["stub.o"] as Uint8Array
    })
    stub.catch(() => (stub = null))
  }
  return stub
}

async function handle({ kind, files, entry, pkgs, preamble }: CppRequest): Promise<Omit<CppResponse, "id">> {
  const { all, includes } = clangInput(files, entry, pkgs)
  const source = `/project/${entry}`
  if (kind === "lint") {
    const { log } = await run(["-fsyntax-only", ...STD, ...includes, source], clangTree(all))
    return { log: relative(log) }
  }
  if (kind === "precompile") {
    all["/pch.hpp"] = preamble!
    const { out } = await run([...STD, ...includes, "-x", "c++-header", "/pch.hpp", "-Xclang", "-emit-pch", "-o", "/pch.hpp.pch"], clangTree(all))
    return { log: "", pch: (out?.["pch.hpp.pch"] as Uint8Array | undefined) ?? undefined }
  }
  all["/stub.o"] = await stubObject()
  const { log, out } = await run([...STD, "-O1", "-Wl,--max-memory=1073741824", ...includes, source, "/stub.o", "-o", "/a.out"], clangTree(all))
  return { log: relative(log), wasm: (out?.["a.out"] as Uint8Array | undefined) ?? undefined }
}

const relative = (log: string) => log.replaceAll("/project/", "")

// One request at a time, in order.
let queue: Promise<void> = Promise.resolve()
self.onmessage = ({ data }: MessageEvent<CppRequest>) => {
  queue = queue.then(async () => {
    let reply: Omit<CppResponse, "id">
    try {
      reply = await handle(data)
    } catch (err) {
      reply = { log: `${err instanceof Error ? err.message : String(err)}\n` }
    }
    const bytes = reply.wasm ?? reply.pch
    const transfer = bytes ? [bytes.buffer] : []
    postMessage({ id: data.id, ...reply } satisfies CppResponse, { transfer })
  })
}
