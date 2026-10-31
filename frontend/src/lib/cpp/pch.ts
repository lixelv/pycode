/** Whether two project snapshots hold the same files (binary files by reference). */
export function sameFiles(a: Record<string, string | Uint8Array>, b: Record<string, string | Uint8Array>) {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}
