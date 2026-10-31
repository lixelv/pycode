/// <reference lib="webworker" />
// Code completion: a second clang instance, so suggestions never wait for a
// lint or a compile. A precompiled header of the file's includes (built by the
// main clang worker) makes an answer take tens of milliseconds; without it, about a second.
import { commands, Exit, type Tree } from "@yowasp/clang"

import { clangInput, clangTree } from "@/lib/cpp/clang-files"
import type { CompleteRequest, CompleteResponse } from "@/lib/cpp/completer"
import { splitPreamble } from "@/lib/cpp/completion"

const clang = commands["clang++"]
const STD = ["-std=c++20", "-fno-color-diagnostics"]

const ready = Promise.resolve(clang(undefined, {}, { fetchProgress: () => {} }))
ready.then(
  () => postMessage({ ready: true }),
  () => postMessage({ ready: false }),
)

let header: { key: string; bytes: Uint8Array } | null = null

async function run(args: string[], files: Tree) {
  let log = ""
  const decoder = new TextDecoder()
  const collect = (bytes: Uint8Array | null) => {
    if (bytes) log += decoder.decode(bytes, { stream: true })
  }
  try {
    await clang(args, files, { stdout: collect, stderr: collect, decodeASCII: false })
  } catch (err) {
    if (!(err instanceof Exit)) throw err
  }
  return log
}

async function complete({ files, entry, source, line, column, pkgs, key }: Extract<CompleteRequest, { type: "complete" }>) {
  const at = ["-Xclang", `-code-completion-at=/project/${entry}:${line}:${column}`, `/project/${entry}`]
  const { all, includes } = clangInput({ ...files, [entry]: source }, entry, pkgs)
  if (header?.key === key) {
    const { preamble, body } = splitPreamble(source)
    const log = await run(["-fsyntax-only", ...STD, ...includes, "-Xclang", "-include-pch", "-Xclang", "/pch.hpp.pch", ...at], clangTree({ ...all, [`/project/${entry}`]: body, "/pch.hpp": preamble, "/pch.hpp.pch": header.bytes }))
    if (log.includes("COMPLETION:") || !/PCH|precompiled/i.test(log)) return log
    // A header it holds has changed: the full parse below still answers.
    header = null
  }
  return run(["-fsyntax-only", ...STD, ...includes, ...at], clangTree(all))
}

let queue: Promise<void> = Promise.resolve()
self.onmessage = ({ data }: MessageEvent<CompleteRequest>) => {
  if (data.type === "header") {
    header = { key: data.key, bytes: data.bytes }
    return
  }
  queue = queue.then(async () => {
    let log = ""
    try {
      log = await complete(data)
    } catch {
      // No suggestions this time.
    }
    postMessage({ id: data.id, log } satisfies CompleteResponse)
  })
}
