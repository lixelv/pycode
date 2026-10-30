/**
 * The time limit of polycode_test.run(timeout=…), shared by the runner worker
 * and the page through `control[DEADLINE_SLOT]`:
 * - 0: no timer is armed;
 * - gen > 0: the worker armed timer `gen` (the page holds a setTimeout for it);
 * - FIRING: the page claimed the timer and is writing the interrupt;
 * - FIRED: the interrupt is written.
 *
 * Cancelling is synchronous: once `disarm()` returns, a late page timer finds
 * its generation gone and does nothing, so no interrupt can reach code after
 * run() (the next statement or the next test).
 */
export const DEADLINE_SLOT = 2
const FIRING = -1
const FIRED = -2

/** Worker: arms timer `gen` (> 0). */
export function arm(control: Int32Array, gen: number) {
  Atomics.store(control, DEADLINE_SLOT, gen)
}

/** Page: interrupts only if timer `gen` is still armed. */
export function fire(control: Int32Array, gen: number, interrupt: () => void) {
  if (Atomics.compareExchange(control, DEADLINE_SLOT, gen, FIRING) !== gen) return
  interrupt()
  Atomics.store(control, DEADLINE_SLOT, FIRED)
  Atomics.notify(control, DEADLINE_SLOT)
}

/**
 * Worker: stops the timer; true if it fired. A written interrupt that Python
 * has not taken yet is cleared, so it cannot land after this returns.
 */
export function disarm(control: Int32Array, interruptFlag: Uint8Array): boolean {
  for (;;) {
    const state = Atomics.load(control, DEADLINE_SLOT)
    if (state === FIRING) {
      Atomics.wait(control, DEADLINE_SLOT, FIRING, 100) // the page is between its two writes
      continue
    }
    if (Atomics.compareExchange(control, DEADLINE_SLOT, state, 0) !== state) continue
    if (state !== FIRED) return false
    interruptFlag[0] = 0
    return true
  }
}
