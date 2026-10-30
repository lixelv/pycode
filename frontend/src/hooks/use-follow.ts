import { useCallback, useEffect, useRef, useState } from "react"

import type { EditorInstance } from "@/components/code-editor"
import type { CollabProvider } from "@/lib/collab/provider"

/** Whom we follow: the acting owner, one member (awareness client id), or nobody. */
export type FollowTarget = "owner" | number | null

/** What each member shows, published in awareness for those following them. */
export interface ViewState {
  tab: string
  file: string
  top: number
}

interface Options {
  provider: CollabProvider | null
  editor: EditorInstance | null
  tab: string
  file: string
  files: string[]
  setTab: (tab: string) => void
  setFile: (file: string) => void
}

/**
 * Follow mode: publishes what we look at (tab, file, scroll) and, while
 * following someone, shows what they look at. Our own navigation stops it
 * (callers use `stop`).
 */
export function useFollow({ provider, editor, tab, file, files, setTab, setFile }: Options) {
  const [target, setTarget] = useState<FollowTarget>(null)
  const awareness = provider?.awareness ?? null

  // Publish our view.
  const top = useRef(0)
  const publish = useCallback(() => {
    awareness?.setLocalStateField("view", { tab, file, top: top.current } satisfies ViewState)
  }, [awareness, tab, file])
  useEffect(publish, [publish])
  useEffect(() => {
    if (!editor || !awareness) return
    let timer = 0
    const sub = editor.onDidScrollChange((e) => {
      top.current = e.scrollTop
      window.clearTimeout(timer)
      timer = window.setTimeout(publish, 100)
    })
    return () => {
      sub.dispose()
      window.clearTimeout(timer)
    }
  }, [editor, awareness, publish])

  // Show the leader's view.
  const leaderId = !provider || target === null ? null : target === "owner" ? (provider.ownerClients()[0] ?? null) : target
  const latest = useRef({ tab, file, files, editor, setTab, setFile })
  useEffect(() => {
    latest.current = { tab, file, files, editor, setTab, setFile }
  })
  useEffect(() => {
    if (!awareness || leaderId === null || leaderId === provider?.clientID) return
    const apply = () => {
      const view = (awareness.getStates().get(leaderId) as { view?: ViewState } | undefined)?.view
      if (!view) return
      const cur = latest.current
      if (view.tab !== cur.tab) cur.setTab(view.tab)
      const switching = view.file !== cur.file && cur.files.includes(view.file)
      if (switching) cur.setFile(view.file)
      // A new file mounts its model first; scroll after that.
      window.setTimeout(() => latest.current.editor?.setScrollTop(view.top), switching ? 80 : 0)
    }
    apply()
    awareness.on("change", apply)
    return () => awareness.off("change", apply)
  }, [awareness, leaderId, provider])

  // Leaving the session ends following.
  useEffect(() => {
    if (!provider) setTarget(null)
  }, [provider])

  return { target, setTarget, stop: useCallback(() => setTarget(null), []), leaderId }
}
