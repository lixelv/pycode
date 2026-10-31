/**
 * What Pyodide gets as its interrupt buffer. Its signal check reads the buffer
 * and then always writes 0 (`_Py_CheckEmscriptenSignals_Helper`), so a Stop the
 * page writes between the two is erased. Here the write happens only after a
 * read that saw a signal. Reading must not consume: `checkInterrupt` peeks at
 * the buffer without the GIL while input() blocks (an Atomics.exchange getter
 * made Stop in input() fail every time).
 *
 * Rests on Pyodide's internals; signal-buffer.test.ts fails if the helper changes.
 */
export function signalBuffer(raw: Uint8Array): { 0: number } {
  let seen = 0
  return {
    get 0() {
      return (seen = Atomics.load(raw, 0))
    },
    set 0(value: number) {
      if (seen) Atomics.store(raw, 0, value)
    },
  }
}
