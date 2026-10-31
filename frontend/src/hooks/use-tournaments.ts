import { useEffect, useMemo, useState } from "react"

import type { AccessView } from "@/hooks/use-access"
import type { ProjectStore } from "@/lib/project/store"
import { readableTournaments, resultsOf, standings, type Standing, type TournamentEntry } from "@/lib/tournament"

export interface TournamentView {
  id: string
  private: boolean
  tasks: string[]
  standings: Standing[]
}

/** The tables we may read, live. */
export function useTournaments(store: ProjectStore, access: AccessView): TournamentView[] {
  const { member, rules } = access
  const key = JSON.stringify(readableTournaments(member, rules, (docId) => store.has(docId)))
  const [version, setVersion] = useState(0)
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1)
    const docs = (JSON.parse(key) as string[]).map((id) => store.doc(`t:${id}`))
    docs.forEach((doc) => doc.on("update", bump))
    bump()
    return () => docs.forEach((doc) => doc.off("update", bump))
  }, [store, key])
  return useMemo(() => {
    return (JSON.parse(key) as string[]).map((id) => {
      const list = standings(resultsOf(store.doc(`t:${id}`)).toJSON() as Record<string, TournamentEntry>)
      return { id, private: rules.tournaments[id].private, tasks: [...new Set(list.flatMap((s) => Object.keys(s.scores)))].sort(), standings: list }
    })
  }, [store, key, rules, version]) // eslint-disable-line react-hooks/exhaustive-deps
}
