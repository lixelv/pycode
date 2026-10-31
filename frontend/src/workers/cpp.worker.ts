/// <reference lib="webworker" />
// Clang (@yowasp/clang, LLVM built for WebAssembly): checks and compiles C++.
// The project lies under /project, packages under /packages; paths in the
// log are made relative to the project.
import { commands, Exit, type Tree } from "@yowasp/clang"

import stubSrc from "@/cpp/stub.cpp?raw"
import pchHeader from "@/cpp/pch.hpp?raw"
import pchUrl from "@/generated/std.pch?url"
import type { CppRequest, CppResponse } from "@/lib/cpp/client"
import { sameFiles } from "@/lib/cpp/pch"

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

// The standard library, precompiled (scripts/build-cpp-pch.mjs). Loaded in the
// background: a compile does not wait for it, and works without it.
let pch: Uint8Array | null = null
let pchLoading = false
function loadPch() {
  if (pch || pchLoading) return
  pchLoading = true
  fetch(pchUrl)
    .then((response) => {
      if (!response.ok) throw new Error(String(response.status))
      return response.arrayBuffer()
    })
    .then((bytes) => (pch = new Uint8Array(bytes)))
    .catch(() => {})
    .finally(() => (pchLoading = false))
}
void ready().then(loadPch, () => {})

// The last lint's verdict. Lints never use the PCH: it would hide a forgotten
// #include. A program the lint refused is compiled without it too.
let lastLint: { files: CppRequest["files"]; entry: string; ok: boolean } | null = null

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

/** `{"/project/a/b.cpp": text}` → clang's nested tree. */
function tree(files: Record<string, string | Uint8Array>): Tree {
  const root: Tree = {}
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split("/").filter(Boolean)
    let dir = root
    for (const part of parts.slice(0, -1)) dir = (dir[part] ??= {}) as Tree
    dir[parts.at(-1)!] = content
  }
  return root
}

async function handle({ kind, files, entry, pkgs }: CppRequest): Promise<Omit<CppResponse, "id">> {
  const all: Record<string, string | Uint8Array> = { ...pkgs.files }
  for (const [path, content] of Object.entries(files)) all[`/project/${path}`] = content
  const folder = entry.includes("/") ? `/project/${entry.slice(0, entry.lastIndexOf("/"))}` : "/project"
  const includes = [...new Set([folder, "/project"]), ...pkgs.includes].map((dir) => `-I${dir}`)
  const source = `/project/${entry}`
  if (kind === "lint") {
    const { log, out } = await run(["-fsyntax-only", ...STD, ...includes, source], tree(all))
    lastLint = { files, entry, ok: out !== null }
    return { log: relative(log) }
  }
  all["/stub.o"] = await stubObject()
  loadPch()
  const compile = [...STD, "-O1", "-Wl,--max-memory=1073741824", ...includes, source, "/stub.o", "-o", "/a.out"]
  const refused = lastLint && !lastLint.ok && lastLint.entry === entry && sameFiles(lastLint.files, files)
  if (pch && !refused) {
    const fast = await run(["-include", "/std.hpp", ...compile], tree({ ...all, "/std.hpp": pchHeader, "/std.hpp.pch": pch }))
    if (fast.out) return { log: relative(fast.log), wasm: fast.out["a.out"] as Uint8Array }
    // The whole library in scope can break a valid program (`using namespace
    // std; int count;`), so only a compile without it decides on an error.
  }
  const { log, out } = await run(compile, tree(all))
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
    const transfer = reply.wasm ? [reply.wasm.buffer] : []
    postMessage({ id: data.id, ...reply } satisfies CppResponse, { transfer })
  })
}
