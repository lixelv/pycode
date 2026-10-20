import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import * as Y from "yjs"

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
  type SessionMode,
} from "@/lib/collab/provider"
import { localProject } from "@/lib/project/project"

export interface Peer {
  clientId: number
  user: PeerUser
  isMe: boolean
  /** The file this person has open. */
  file?: string
  /** How we are connected to them: directly (WebRTC) or through the server. */
  link?: LinkMode
}

const SESSION_PATH = /^\/s\/([A-Za-z0-9-]+)\/?$/

/**
 * The live session. The owner shares their own project (their local doc, so
 * every change is saved in their browser); a guest works on a fresh doc that
 * fills from the others and is dropped on leaving — back to their own project.
 */
export function useCollab() {
  const [me, setMe] = useState<string | null>(null)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [provider, setProvider] = useState<CollabProvider | null>(null)
  const [status, setStatus] = useState<ProviderStatus | null>(null)
  const [peers, setPeers] = useState<Peer[]>([])
  const [, force] = useState(0)

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
      const doc = isOwner ? localProject().doc : new Y.Doc()
      if (isOwner) await localProject().ready
      attach(new CollabProvider(session, me, doc))
    },
    [me, attach],
  )

  const start = useCallback(
    async (mode: SessionMode) => {
      if (!me) throw new Error("The collaboration server is not available.")
      const { session } = await createSession(mode)
      await localProject().ready
      attach(new CollabProvider(session, me, localProject().doc))
    },
    [me, attach],
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
        if (s.user) list.push({ clientId, user: s.user, isMe: clientId === provider.doc.clientID, file: s.file, link: modes.get(clientId) })
      })
      list.sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.user.id.localeCompare(b.user.id))
      setPeers(list)
    }
    readPeers()
    provider.awareness.on("change", readPeers)
    const offLinks = provider.on("links", readPeers)
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
      off()
    }
  }, [provider, leave])

  return { me, available, provider, status, peers, start, join, leave, end }
}

function dispose(p: CollabProvider | null) {
  if (!p) return
  const guestDoc = p.doc !== localProject().doc ? p.doc : null
  p.destroy()
  guestDoc?.destroy()
}
