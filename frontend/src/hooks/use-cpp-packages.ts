import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type * as Y from "yjs"

import { applyLoadFailures, installCppPackage, parseCppSpec, type CppPackage } from "@/lib/cpp/packages"

/**
 * The project's C++ package list (a Y.Array in `structure`): saved with the
 * project and shared in a session. The admin who adds a package downloads it;
 * everyone else downloads it lazily before a lint or run.
 */
export function useCppPackages(shared: Y.Array<CppPackage>) {
  const [stored, setPackages] = useState<CppPackage[]>(() => shared.toArray())
  // Packages that are installed in the project but did not load here (offline…), keyed `repo@version`: shown as errors, not retried by every lint.
  const [failed, setFailed] = useState<Record<string, string>>({})
  const packages = useMemo(() => applyLoadFailures(stored, failed), [stored, failed])
  const current = useRef(shared)
  // A lint of the previous project may still report here: `shared` tells it apart.
  const fail = useCallback(
    (repo: string, version: string, error: string) => {
      if (current.current === shared) setFailed((f) => ({ ...f, [`${repo}@${version}`]: error }))
    },
    [shared],
  )
  // Every key of the repo, whatever its version.
  const clearFailure = useCallback(
    (repo: string) => setFailed((f) => (Object.keys(f).some((k) => k.startsWith(`${repo}@`)) ? Object.fromEntries(Object.entries(f).filter(([k]) => !k.startsWith(`${repo}@`))) : f)),
    [],
  )

  useEffect(() => {
    current.current = shared
    // Another project or session: what failed to load there says nothing about this list.
    setFailed((f) => (Object.keys(f).length ? {} : f))
    const read = () => setPackages(shared.toArray())
    read()
    shared.observe(read)
    return () => shared.unobserve(read)
  }, [shared])

  const mutate = useCallback(
    (fn: (list: CppPackage[]) => CppPackage[]) => {
      shared.doc!.transact(() => {
        const next = fn(shared.toArray())
        shared.delete(0, shared.length)
        shared.push(next)
      })
    },
    [shared],
  )

  const patch = useCallback(
    (repo: string, change: Partial<CppPackage>) => mutate((list) => list.map((p) => (p.repo === repo ? { ...p, ...change } : p))),
    [mutate],
  )

  const install = useCallback(
    async (repo: string, version: string | null) => {
      try {
        const { version: resolved, include } = await installCppPackage(repo, version)
        patch(repo, { status: "installed", version: resolved, include, error: undefined })
      } catch (error) {
        patch(repo, { status: "error", error: error instanceof Error ? error.message : String(error) })
      }
    },
    [patch],
  )

  const add = useCallback(
    async (input: string) => {
      const parsed = parseCppSpec(input)
      if (!parsed) return
      clearFailure(parsed.repo)
      const entry: CppPackage = { ...parsed, status: "installing" }
      mutate((list) => [...list.filter((p) => p.repo !== parsed.repo), entry])
      await install(parsed.repo, parsed.ref)
    },
    [mutate, install, clearFailure],
  )

  const remove = useCallback(
    (repo: string) => {
      clearFailure(repo)
      mutate((list) => list.filter((p) => p.repo !== repo))
    },
    [mutate, clearFailure],
  )

  const retry = useCallback(
    (repo: string) => {
      const entries = stored.filter((p) => p.repo === repo)
      const entry = entries[0]
      if (!entry) return
      clearFailure(repo)
      // Installed in the project, only this browser failed to load it: the next lint loads it again, the shared list stays as it is.
      if (entries.some((p) => p.status === "installed")) return
      patch(repo, { status: "installing", error: undefined })
      void install(repo, entry.version ?? entry.ref)
    },
    [stored, patch, install, clearFailure],
  )

  return { packages, add, remove, retry, fail }
}
