import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { fetchMe } from "@/lib/collab/identity"
import { translate } from "@/lib/i18n"
import {
  CollabProvider,
  createSession,
  endSession,
  getSession,
  type LinkMode,
  type PeerUser,
  type ProviderStatus,
} from "@/lib/collab/provider"
import type { Member } from "@/lib/project/access"
import { localStore, rolesOf } from "@/lib/project/project"
import { ProjectStore } from "@/lib/project/store"

export interface Peer {
  clientId: number
  user: PeerUser
  isMe: boolean
  /** The file this person has open. */
  file?: string
  /** How we are connected to them: directly (WebRTC) or through the server. */
  link?: LinkMode
  /** Their level and roles, and their member number (to change them). */
  member?: Member & { peer: number; acting: boolean }
}

const SESSION_PATH = /^\/s\/([A-Za-z0-9-]+)\/?$/

/**
 * The live session. The owner shares their own project (their local store, so
 * every change is saved in their browser); a guest works on a fresh store that
 * fills from the others and is dropped on leaving — back to their own project.
 */
export function useCollab() {
  const [me, setMe] = useState<string | null>(null)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [provider, setProvider] = useState<CollabProvider | null>(null)
  const [status, setStatus] = useState<ProviderStatus | null>(null)
  const [peers, setPeers] = useState<Peer[]>([])
  // A session that asks for names waits here for ours (see NameDialog).
  const [nameAsk, setNameAsk] = useState<{ initial: string | null; resolve: (name: string) => void } | null>(null)
  const askName = useCallback((sessionId: string) => {
    const key = `polycode:name:${sessionId}`
    const saved = storage(key)
    if (saved) return Promise.resolve(saved)
    return new Promise<string>((resolve) =>
      setNameAsk({
        initial: storage(LAST_NAME),
        resolve: (name) => {
          storage(key, name)
          storage(LAST_NAME, name)
          setNameAsk(null)
          resolve(name)
        },
      }),
    )
  }, [])

  // Bumped whenever our role, the links or the acting owner change.
  const [version, force] = useState(0)

  useEffect(() => {
    fetchMe().then((m) => {
      setMe(m?.id ?? null)
      setAvailable(!!m)
    })
  }, [])

  const attach = useCallback((p: CollabProvider) => {
    setProvider((old) => {
      dispose(old)
      return p
    })
    history.replaceState(null, "", `/s/${p.code}`)
  }, [])

  const join = useCallback(
    async (rawCode: string) => {
      if (!me) throw new Error("The collaboration server is not available.")
      const code = rawCode.trim().replace(/^.*\/s\//, "")
      const { session } = await getSession(code)
      if (session.endedAt) throw new Error("This session has ended.")
      const isOwner = session.ownerId === me
      // The owner rejoining shares their own project again.
      const name = session.askName ? await askName(session.id) : null
      const store = isOwner ? localStore() : new ProjectStore(false)
      await store.ready
      attach(new CollabProvider(session, me, store, name))
    },
    [me, attach, askName],
  )

  const start = useCallback(
    async (ask: boolean) => {
      if (!me) throw new Error("The collaboration server is not available.")
      const roles = Object.entries(rolesOf(localStore()).toJSON() as Record<string, "read" | "write">).map(([name, level]) => ({ name, level }))
      const { session } = await createSession(ask, roles)
      const name = ask ? await askName(session.id) : null
      await localStore().ready
      attach(new CollabProvider(session, me, localStore(), name))
    },
    [me, attach, askName],
  )

  const leave = useCallback(() => {
    setProvider((old) => {
      dispose(old)
      return null
    })
    setPeers([])
    setStatus(null)
    history.replaceState(null, "", "/")
  }, [])

  const end = useCallback(async () => {
    if (!provider) return
    await endSession(provider.code)
    leave()
  }, [provider, leave])

  // Join from a /s/<code> link.
  useEffect(() => {
    const m = SESSION_PATH.exec(location.pathname)
    if (!m || !me) return
    join(m[1]).catch((err: Error) => {
      toast.error(err.message)
      history.replaceState(null, "", "/")
    })
  }, [me, join])

  // Track status and the people in the session.
  useEffect(() => {
    if (!provider) return
    const readPeers = () => {
      const modes = provider.linkModes()
      const list: Peer[] = []
      provider.awareness.getStates().forEach((state, clientId) => {
        const s = state as { user?: PeerUser; file?: string }
        if (s.user)
          list.push({ clientId, user: s.user, isMe: clientId === provider.clientID, file: s.file, link: modes.get(clientId), member: provider.memberOf(clientId) ?? undefined })
      })
      list.sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.user.id.localeCompare(b.user.id))
      setPeers(list)
    }
    readPeers()
    provider.awareness.on("change", readPeers)
    const offError = provider.on("error", (message) => toast.error(message))
    const offLinks = provider.on("links", () => {
      readPeers()
      force((n) => n + 1)
    })
    const off = provider.on("status", (s) => {
      setStatus(s)
      force((n) => n + 1) // role may have changed
      if (s === "ended") {
        toast.message(translate("toast.sessionEnded"))
        leave()
      }
    })
    setStatus(provider.status)
    return () => {
      provider.awareness.off("change", readPeers)
      offLinks()
      offError()
      off()
    }
  }, [provider, leave])

  return { me, available, provider, status, version, peers, nameAsk, start, join, leave, end }
}

const LAST_NAME = "polycode:name"

/** Reads (or with a value, writes) localStorage, ignoring unavailable storage. */
function storage(key: string, value?: string): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key)
    localStorage.setItem(key, value)
  } catch {
    // storage unavailable
  }
  return null
}

function dispose(p: CollabProvider | null) {
  if (!p) return
  const guest = p.store !== localStore() ? p.store : null
  p.destroy()
  guest?.destroy()
}
