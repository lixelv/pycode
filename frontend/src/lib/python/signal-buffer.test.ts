import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

import { describe, expect, it } from "vitest"

import { signalBuffer } from "./signal-buffer"

const setup = () => {
  const raw = new Uint8Array(new SharedArrayBuffer(1))
  return { raw, buffer: signalBuffer(raw) }
}

/** What Pyodide's _Py_CheckEmscriptenSignals_Helper does; `between` is the page writing from another thread. */
const poll = (buffer: { 0: number }, between: () => void = () => {}) => {
  const result = buffer[0]
  between()
  buffer[0] = 0
  return result
}

describe("signalBuffer", () => {
  it("a Stop written between the helper's read and write survives", () => {
    const { raw, buffer } = setup()
    expect(poll(buffer, () => (raw[0] = 2))).toBe(0)
    expect(raw[0]).toBe(2)
    expect(poll(buffer)).toBe(2) // the next poll delivers it
  })

  it("a signal the helper read is consumed by its write", () => {
    const { raw, buffer } = setup()
    raw[0] = 2
    expect(poll(buffer)).toBe(2)
    expect(raw[0]).toBe(0)
    expect(poll(buffer)).toBe(0)
  })

  it("reading alone does not consume: checkInterrupt peeks at the buffer while input() blocks", () => {
    const { raw, buffer } = setup()
    raw[0] = 2
    expect(buffer[0]).toBe(2)
    expect(buffer[0]).toBe(2)
    expect(raw[0]).toBe(2)
  })

  it("rests on Pyodide's helper reading then writing: recheck signalBuffer if this changes", () => {
    const require = createRequire(import.meta.url)
    const dir = dirname(require.resolve("pyodide/package.json"))
    const source = readFileSync(join(dir, "pyodide.asm.mjs"), "utf8")
    expect(source).toMatch(/let result=Module\.Py_EmscriptenSignalBuffer\[0\];Module\.Py_EmscriptenSignalBuffer\[0\]=0;return result/)
  })
})
