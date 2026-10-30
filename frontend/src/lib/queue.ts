/** Runs async tasks one at a time, in the order they were given. */
export function serial() {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task)
    tail = next.catch(() => {})
    return next
  }
}
