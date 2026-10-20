import { useCallback, useEffect, useState } from "react"
import type * as Y from "yjs"

import { runner } from "@/lib/python/runner-client"
import { callTool } from "@/lib/python/tools-client"

export type PackageStatus = "installing" | "installed" | "error"

export interface PackageEntry {
  /** What the user typed, e.g. "requests" or "numpy==2.4.6". */
  spec: string
  name: string
  /** Version requested with ==, or null for latest. */
  requested: string | null
  /** Version resolved by the first successful install; pinned from then on. */
  version?: string
  status: PackageStatus
  error?: string
}

const SPEC = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)(\[[A-Za-z0-9,._ -]+\])?\s*(?:==\s*([A-Za-z0-9.+!_-]+))?\s*$/

export function parseSpec(input: string): { name: string; requested: string | null; spec: string } | null {
  const m = SPEC.exec(input)
  if (!m) return null
  const name = m[1].toLowerCase().replace(/[-_.]+/g, "-")
  const requested = m[3] ?? null
  return { name, requested, spec: `${m[1]}${m[2] ?? ""}${requested ? `==${requested}` : ""}` }
}

/** The spec actually installed: pinned to the resolved version once known. */
export function pinnedSpec(p: PackageEntry) {
  const base = p.spec.replace(/==.*$/, "")
  return p.version ? `${base}==${p.version}` : p.spec
}

/**
 * The project's package list (a Y.Array in the project doc): saved with the
 * user's own project, and shared with everyone in a live session.
 */
export function usePackages(shared: Y.Array<PackageEntry>) {
  const [packages, setPackages] = useState<PackageEntry[]>(() => shared.toArray())

  useEffect(() => {
    const read = () => setPackages(shared.toArray())
    read()
    // A removed package cannot be unloaded: the next run uses a fresh interpreter.
    const onChange = (event: Y.YArrayEvent<PackageEntry>) => {
      read()
      if (event.changes.deleted.size > 0 && event.changes.added.size === 0) runner.restart()
    }
    shared.observe(onChange)
    return () => shared.unobserve(onChange)
  }, [shared])

  const mutate = useCallback(
    (fn: (list: PackageEntry[]) => PackageEntry[]) => {
      shared.doc!.transact(() => {
        const next = fn(shared.toArray())
        shared.delete(0, shared.length)
        shared.push(next)
      })
    },
    [shared],
  )

  const patch = useCallback(
    (name: string, change: Partial<PackageEntry>) => mutate((list) => list.map((p) => (p.name === name ? { ...p, ...change } : p))),
    [mutate],
  )

  const add = useCallback(
    async (input: string) => {
      const parsed = parseSpec(input)
      if (!parsed) return
      const entry: PackageEntry = { ...parsed, status: "installing" }
      mutate((list) => [...list.filter((p) => p.name !== parsed.name), entry])
      const [result] = await runner.install([parsed.spec])
      if (!result || result.error) {
        patch(parsed.name, { status: "error", error: result?.error ?? "Installation was cancelled." })
      } else {
        patch(parsed.name, { status: "installed", version: result.version, error: undefined })
        // Let code hints see the new package too.
        void callTool("install", { specs: [`${parsed.spec.replace(/==.*$/, "")}==${result.version}`] }).catch(() => {})
      }
    },
    [mutate, patch],
  )

  const remove = useCallback((name: string) => mutate((list) => list.filter((p) => p.name !== name)), [mutate])

  const retry = useCallback(
    (name: string) => {
      const entry = packages.find((p) => p.name === name)
      if (entry) void add(entry.spec)
    },
    [packages, add],
  )

  const activeSpecs = packages.filter((p) => p.status === "installed").map(pinnedSpec)
  return { packages, activeSpecs, add, remove, retry }
}
