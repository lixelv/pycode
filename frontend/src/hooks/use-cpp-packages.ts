import { useCallback, useEffect, useState } from "react"
import type * as Y from "yjs"

import { installCppPackage, parseCppSpec, type CppPackage } from "@/lib/cpp/packages"

/**
 * The project's C++ package list (a Y.Array in `structure`): saved with the
 * project and shared in a session. The admin who adds a package downloads it;
 * everyone else downloads it lazily before a lint or run.
 */
export function useCppPackages(shared: Y.Array<CppPackage>) {
  const [packages, setPackages] = useState<CppPackage[]>(() => shared.toArray())

  useEffect(() => {
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
      const entry: CppPackage = { ...parsed, status: "installing" }
      mutate((list) => [...list.filter((p) => p.repo !== parsed.repo), entry])
      await install(parsed.repo, parsed.ref)
    },
    [mutate, install],
  )

  const remove = useCallback((repo: string) => mutate((list) => list.filter((p) => p.repo !== repo)), [mutate])

  const retry = useCallback(
    (repo: string) => {
      const entry = packages.find((p) => p.repo === repo)
      if (!entry) return
      patch(repo, { status: "installing", error: undefined })
      void install(repo, entry.version ?? entry.ref)
    },
    [packages, patch, install],
  )

  return { packages, add, remove, retry }
}
