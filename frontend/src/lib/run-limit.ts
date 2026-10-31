/** At most `max` passes per sliding window; a refused call does not count. */
export function createRunLimit(max: number, windowMs: number) {
  let passed: number[] = []
  return {
    allow(now: number): boolean {
      passed = passed.filter((t) => now - t < windowMs)
      if (passed.length >= max) return false
      passed.push(now)
      return true
    },
  }
}
