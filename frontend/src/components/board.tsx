import { CaptureUpdateAction, Excalidraw, reconcileElements } from "@excalidraw/excalidraw"
import "@excalidraw/excalidraw/index.css"
import type { ExcalidrawElement, OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { AppState, BinaryFileData, BinaryFiles, Collaborator, ExcalidrawImperativeAPI, SocketId } from "@excalidraw/excalidraw/types"
import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import type { Awareness } from "y-protocols/awareness"

import type { PeerUser } from "@/lib/collab/provider"
import { translate } from "@/lib/i18n"
import { PROJECT_LIMIT, projectSize } from "@/lib/project/project"
import type { ProjectStore } from "@/lib/project/store"

// The whiteboard's fonts are served by us (see scripts/copy-excalidraw.mjs).
Object.assign(window, { EXCALIDRAW_ASSET_PATH: "/excalidraw/" })

interface BoardView {
  scrollX: number
  scrollY: number
  zoom: number
}

/**
 * The project's whiteboard (Excalidraw), shared through store.board:
 *   elements  Y.Map<id, element>   the newest version of each element wins
 *   files     Y.Map<id, file>      pictures, as data URLs (count toward the project limit)
 * Pointers travel in awareness (boardPointer), the visible area too
 * (boardView) for those following someone.
 */
export default function Board({
  store,
  awareness,
  readOnly,
  theme,
  labels,
  leaderId,
}: {
  store: ProjectStore
  awareness: Awareness | null
  readOnly: boolean
  theme: "dark" | "light"
  labels: boolean
  /** Following someone: show what they see. */
  leaderId: number | null
}) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  // End-to-end tests read the scene through this (only where the app exposes its own hook).
  useEffect(() => {
    const hook = (window as { __polycode?: Record<string, unknown> }).__polycode
    if (hook && api) hook.board = api
  }, [api])
  const elements = store.board.getMap<ExcalidrawElement>("elements")
  const files = store.board.getMap<BinaryFileData>("files")
  // Versions we have seen or sent, so onChange only shares real changes.
  const known = useRef(new Map<string, number>())
  // Excalidraw sets its scene up after mounting, from initialData: start it
  // from the board document (an update sent before that would be wiped).
  const [initialData] = useState(() => ({
    elements: [...elements.values()],
    files: Object.fromEntries([...files.entries()]) as BinaryFiles,
  }))
  useEffect(() => {
    initialData.elements.forEach((e) => known.current.set(e.id, e.version))
  }, [initialData])

  // Remote changes into the scene.
  useEffect(() => {
    if (!api) return
    const apply = () => {
      const remote = [...elements.values()]
      remote.forEach((e) => known.current.set(e.id, e.version))
      const merged = reconcileElements(api.getSceneElementsIncludingDeleted(), remote as never, api.getAppState())
      api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER })
      const missing = [...files.values()].filter((f) => !api.getFiles()[f.id])
      if (missing.length) api.addFiles(missing)
    }
    apply()
    elements.observe(apply)
    files.observe(apply)
    return () => {
      elements.unobserve(apply)
      files.unobserve(apply)
    }
  }, [api, elements, files])

  // Our changes out.
  const onChange = (scene: readonly OrderedExcalidrawElement[], appState: AppState, sceneFiles: BinaryFiles) => {
    if (readOnly) return
    const changed = scene.filter((e) => (known.current.get(e.id) ?? -1) < e.version)
    const newFiles = Object.values(sceneFiles).filter((f) => !files.has(f.id))
    if (changed.length || newFiles.length) {
      const grow = newFiles.reduce((n, f) => n + f.dataURL.length, 0)
      const fits = !grow || projectSize(store) + grow <= PROJECT_LIMIT
      if (!fits) toast.error(translate("toast.tooBig", { mb: PROJECT_LIMIT >> 20 }))
      store.board.transact(() => {
        for (const e of changed) {
          known.current.set(e.id, e.version)
          elements.set(e.id, e)
        }
        if (fits) for (const f of newFiles) files.set(f.id, f)
      })
    }
    awareness?.setLocalStateField("boardView", { scrollX: appState.scrollX, scrollY: appState.scrollY, zoom: appState.zoom.value } satisfies BoardView)
  }

  // Everyone's pointers.
  useEffect(() => {
    if (!api || !awareness) return
    const show = () => {
      const collaborators = new Map<SocketId, Collaborator>()
      awareness.getStates().forEach((state, id) => {
        const s = state as { user?: PeerUser; boardPointer?: { x: number; y: number } }
        if (id === awareness.clientID || !s.user || !s.boardPointer) return
        collaborators.set(String(id) as SocketId, {
          pointer: { x: s.boardPointer.x, y: s.boardPointer.y, tool: "pointer" },
          username: labels ? s.user.name : "",
          color: { background: s.user.color, stroke: s.user.color },
        })
      })
      api.updateScene({ collaborators })
    }
    show()
    awareness.on("change", show)
    return () => awareness.off("change", show)
  }, [api, awareness, labels])

  // Following someone: their visible area.
  useEffect(() => {
    if (!api || !awareness || leaderId === null) return
    const follow = () => {
      const view = (awareness.getStates().get(leaderId) as { boardView?: BoardView } | undefined)?.boardView
      if (view) api.updateScene({ appState: { scrollX: view.scrollX, scrollY: view.scrollY, zoom: { value: view.zoom as never } } })
    }
    follow()
    awareness.on("change", follow)
    return () => awareness.off("change", follow)
  }, [api, awareness, leaderId])

  const lastPointer = useRef(0)
  return (
    <div className="size-full">
      <Excalidraw
        excalidrawAPI={setApi}
        initialData={initialData}
        theme={theme}
        viewModeEnabled={readOnly}
        isCollaborating={!!awareness}
        onChange={onChange}
        onPointerUpdate={({ pointer }) => {
          const now = performance.now()
          if (!awareness || now - lastPointer.current < 50) return
          lastPointer.current = now
          awareness.setLocalStateField("boardPointer", { x: pointer.x, y: pointer.y })
        }}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: false } }}
      />
    </div>
  )
}
