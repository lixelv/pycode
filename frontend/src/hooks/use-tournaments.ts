import { useEffect, useMemo, useState } from "react"

import type { AccessView } from "@/hooks/use-access"
import { docAccess } from "@/lib/project/access"
import type { ProjectStore } from "@/lib/project/store"
import { resultsOf, standings, type Standing, type TournamentEntry } from "@/lib/tournament"

export interface TournamentView {
  id: string
  private: boolean
  tasks: string[]
  standings: Standing[]
}

/**
 * The tables we may read, live. Decided by access, not by which documents exist:
 * a student keeps the copy of a table that became private, and must not see it.
 */
export function useTournaments(store: ProjectStore, access: AccessView): TournamentView[] {
  const { member, rules } = access
  const ids = Object.keys(rules.tournaments)
    .filter((id) => docAccess(member, `t:${id}`, rules) !== "none")
    .sort()
    .join("\n")
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1)
    const docs = ids ? ids.split("\n").map((id) => store.doc(`t:${id}`)) : []
    docs.forEach((doc) => doc.on("update", bump))
    bump()
    return () => docs.forEach((doc) => doc.off("update", bump))
  }, [store, ids])
  return useMemo(() => {
    if (!ids) return []
    return ids.split("\n").map((id) => {
      const list = standings(resultsOf(store.doc(`t:${id}`)).toJSON() as Record<string, TournamentEntry>)
      return { id, private: rules.tournaments[id].private, tasks: [...new Set(list.flatMap((s) => Object.keys(s.scores)))].sort(), standings: list }
    })
  }, [store, ids, rules, version]) // eslint-disable-line react-hooks/exhaustive-deps
}
