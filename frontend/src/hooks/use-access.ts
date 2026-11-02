import { useEffect, useMemo, useState } from "react"

import type { CollabProvider } from "@/lib/collab/provider"
import { docAccess, fileAccess, type Access, type Member, type Rules } from "@/lib/project/access"
import { rulesOf } from "@/lib/project/project"
import type { ProjectStore } from "@/lib/project/store"

const SOLO: Member = { level: "admin", roles: [], owner: true }
/** A stranger on a public project: reads everything it was given, changes nothing of it. */
const VIEWER: Member = { level: "read", roles: [] }

export interface AccessView {
  member: Member
  rules: Rules
  isAdmin: boolean
  frozen: boolean
  /** May run programs, type into the console, draw on the board. */
  canRun: boolean
  can: (path: string) => Access
}

/** What we may do in the project: everything alone, by our role in a session. */
export function useAccess(store: ProjectStore, provider: CollabProvider | null, version: unknown, viewOnly = false): AccessView {
  const [rules, setRules] = useState(() => rulesOf(store))
  useEffect(() => {
    const read = () => setRules(rulesOf(store))
    read()
    store.structure.on("update", read)
    return () => store.structure.off("update", read)
  }, [store])
  // `version` changes when the provider learns our role.
  const member = useMemo(() => (viewOnly ? VIEWER : (provider?.member ?? SOLO)), [provider, version, viewOnly]) // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(
    () => ({
      member,
      rules,
      isAdmin: member.level === "admin",
      frozen: rules.frozen,
      // A viewer's console is their own: the project stays in memory on this page.
      canRun: viewOnly || docAccess(member, "runtime", rules) === "write",
      can: (path: string) => fileAccess(member, path, rules),
    }),
    [member, rules, viewOnly],
  )
}
