import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types"
import type { BinaryFileData, BinaryFiles } from "@excalidraw/excalidraw/types"

import type { ProjectStore } from "@/lib/project/store"

/*
 * The whiteboard for an agent, written straight to store.board: an open Board
 * merges from there, so everyone sees it, and it works with the board closed.
 * The tools follow the element-level ones of github.com/yctimlin/mcp_excalidraw
 * (MIT), with Excalidraw's own skeleton format as input.
 */

type Item = Record<string, unknown>
type Mutable = ExcalidrawElement & Item

const elementsOf = (s: ProjectStore) => s.board.getMap<ExcalidrawElement>("elements")
const live = (s: ProjectStore) => [...elementsOf(s).values()].filter((e) => !e.isDeleted)
const excalidraw = () => import("@excalidraw/excalidraw")

/** What an agent needs of an element, without Excalidraw's bookkeeping. */
export function boardRead(s: ProjectStore) {
  const keys = ["id", "type", "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor", "text", "containerId", "groupIds"]
  return live(s).map((element) => {
    const e = element as unknown as Item
    const out: Item = Object.fromEntries(keys.filter((k) => e[k] !== undefined).map((k) => [k, e[k]]))
    const bound = e.startBinding as { elementId?: string } | null | undefined
    const end = e.endBinding as { elementId?: string } | null | undefined
    if (bound?.elementId) out.start = bound.elementId
    if (end?.elementId) out.end = end.elementId
    if (Array.isArray(e.points)) out.points = e.points
    return out
  })
}

/** A new version of an element, the way Excalidraw marks a change, so it wins when merged. */
function changed(element: ExcalidrawElement, props: Item): ExcalidrawElement {
  return { ...element, ...props, version: element.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: Date.now() } as ExcalidrawElement
}

const GAP = 8
type Box = { x: number; y: number; width: number; height: number }

/** Where the line from the box's centre towards (tx, ty) leaves the box, plus a small gap. */
function edgePoint(box: Box, tx: number, ty: number) {
  const cx = box.x + box.width / 2
  const cy = box.y + box.height / 2
  const dx = tx - cx
  const dy = ty - cy
  const scale = Math.min(dx ? (box.width / 2 + GAP) / Math.abs(dx) : Infinity, dy ? (box.height / 2 + GAP) / Math.abs(dy) : Infinity, 1)
  return { x: cx + dx * scale, y: cy + dy * scale }
}

/**
 * Excalidraw binds an arrow's ends but keeps the arrow where the skeleton put it (and a width
 * of 0 becomes its default), so an arrow joining two elements is drawn from edge to edge here.
 */
export function routeArrows(skeletons: Item[], known: (id: string) => Box | undefined): Item[] {
  const boxOf = (id: unknown) => {
    if (id === undefined) return undefined
    const own = skeletons.find((e) => e.id === id) as Partial<Box> | undefined
    if (own && typeof own.x === "number" && typeof own.y === "number") return { x: own.x, y: own.y, width: own.width ?? 0, height: own.height ?? 0 }
    return known(String(id))
  }
  return skeletons.map((skeleton) => {
    if (skeleton.type !== "arrow" && skeleton.type !== "line") return skeleton
    const from = boxOf((skeleton.start as { id?: string } | undefined)?.id)
    const to = boxOf((skeleton.end as { id?: string } | undefined)?.id)
    if (!from || !to) return skeleton
    const a = edgePoint(from, to.x + to.width / 2, to.y + to.height / 2)
    const b = edgePoint(to, from.x + from.width / 2, from.y + from.height / 2)
    // Excalidraw takes 0 for "not given".
    return { ...skeleton, x: a.x, y: a.y, width: b.x - a.x || 0.01, height: b.y - a.y || 0.01 }
  })
}

/** Adds skeletons; `id`s of existing elements may be referred to by arrows. Returns the new ids. */
export async function boardAdd(s: ProjectStore, skeletons: Item[], route = true): Promise<string[]> {
  const { convertToExcalidrawElements } = await excalidraw()
  const elements = elementsOf(s)
  // An arrow bound to an element of an earlier call needs that element beside it while converting.
  const named = new Set(skeletons.map((e) => e.id))
  const referred = new Set(skeletons.flatMap((e) => [e.start, e.end]).map((end) => (end as { id?: string } | undefined)?.id).filter((id): id is string => !!id && !named.has(id)))
  const known = [...referred].flatMap((id) => {
    const element = elements.get(id)
    if (!element || element.isDeleted) throw new Error(`no element ${id} on the board`)
    return [element as unknown as Item]
  })
  const routed = !route
    ? skeletons
    : routeArrows(skeletons, (id) => {
        const element = elements.get(id)
        return element && !element.isDeleted ? element : undefined
      })
  const converted = convertToExcalidrawElements([...known, ...routed] as never, { regenerateIds: false })
  const old = new Set(known.map((e) => e.id))
  s.board.transact(() => {
    for (const element of converted) {
      if (!old.has(element.id)) elements.set(element.id, element as ExcalidrawElement)
      else {
        // The old one gained a binding to the arrow.
        const bound = (element as ExcalidrawElement).boundElements
        elements.set(element.id, changed(elements.get(element.id)!, { boundElements: bound }))
      }
    }
  })
  return converted.filter((e) => !old.has(e.id)).map((e) => e.id)
}

export function boardUpdate(s: ProjectStore, items: Item[]) {
  const elements = elementsOf(s)
  for (const item of items) {
    const current = elements.get(String(item.id))
    if (!current || current.isDeleted) throw new Error(`no element ${String(item.id)} on the board`)
  }
  s.board.transact(() => {
    for (const { id, ...props } of items) {
      const element = elements.get(String(id))!
      // Text is drawn from originalText too.
      const text = typeof props.text === "string" ? { originalText: props.text } : {}
      elements.set(element.id, changed(element, { ...props, ...text, id: element.id }))
    }
  })
}

/** Deletes elements (Excalidraw keeps them marked, so the deletion wins everywhere), with their bound text. */
export function boardDelete(s: ProjectStore, ids: string[]) {
  const elements = elementsOf(s)
  const gone = new Set(ids)
  for (const element of elements.values()) {
    const owner = (element as Mutable).containerId as string | null | undefined
    if (owner && gone.has(owner)) gone.add(element.id)
  }
  s.board.transact(() => {
    for (const id of gone) {
      const element = elements.get(id)
      if (element && !element.isDeleted) elements.set(id, changed(element, { isDeleted: true }))
    }
  })
}

export const boardClear = (s: ProjectStore) => boardDelete(s, live(s).map((e) => e.id))

export async function boardMermaid(s: ProjectStore, definition: string, x = 0, y = 0): Promise<string[]> {
  const { parseMermaidToExcalidraw } = await import("@excalidraw/mermaid-to-excalidraw")
  const { elements, files } = await parseMermaidToExcalidraw(definition)
  if (files) {
    const map = s.board.getMap<BinaryFileData>("files")
    s.board.transact(() => Object.values(files).forEach((f) => map.set(f.id, f as BinaryFileData)))
  }
  const moved = elements.map((e) => ({ ...e, x: (e.x ?? 0) + x, y: (e.y ?? 0) + y }))
  return boardAdd(s, moved as unknown as Item[], false) // Mermaid laid its arrows out itself
}

/** A PNG of the board, or of some elements; null when there is nothing to draw. */
export async function boardImage(s: ProjectStore, ids?: string[]): Promise<Blob | null> {
  const { exportToBlob } = await excalidraw()
  const wanted = ids && new Set(ids)
  const elements = live(s).filter((e) => !wanted || wanted.has(e.id) || wanted.has((e as Mutable).containerId as string))
  if (!elements.length) return null
  const files = Object.fromEntries(s.board.getMap<BinaryFileData>("files").entries()) as BinaryFiles
  return exportToBlob({ elements: elements as never, files, mimeType: "image/png", maxWidthOrHeight: 1600, appState: { exportBackground: true, viewBackgroundColor: "#ffffff" } })
}

function chosen(s: ProjectStore, ids: string[]): ExcalidrawElement[] {
  const elements = elementsOf(s)
  return ids.map((id) => {
    const element = elements.get(id)
    if (!element || element.isDeleted) throw new Error(`no element ${id} on the board`)
    return element
  })
}

/** Text bound to these elements moves and locks with them. */
function withLabels(s: ProjectStore, list: ExcalidrawElement[]): ExcalidrawElement[] {
  const ids = new Set(list.map((e) => e.id))
  return [...list, ...live(s).filter((e) => !ids.has(e.id) && ids.has((e as Mutable).containerId as string))]
}

function commit(s: ProjectStore, list: ExcalidrawElement[]) {
  const elements = elementsOf(s)
  s.board.transact(() => list.forEach((e) => elements.set(e.id, e)))
}

export type Alignment = "left" | "center" | "right" | "top" | "middle" | "bottom"

/** Lines the elements up with the outermost of them. */
export function boardAlign(s: ProjectStore, ids: string[], alignment: Alignment) {
  const list = chosen(s, ids)
  const left = Math.min(...list.map((e) => e.x))
  const right = Math.max(...list.map((e) => e.x + e.width))
  const top = Math.min(...list.map((e) => e.y))
  const bottom = Math.max(...list.map((e) => e.y + e.height))
  const target = (e: ExcalidrawElement) => {
    if (alignment === "left") return { x: left }
    if (alignment === "right") return { x: right - e.width }
    if (alignment === "center") return { x: (left + right - e.width) / 2 }
    if (alignment === "top") return { y: top }
    if (alignment === "bottom") return { y: bottom - e.height }
    return { y: (top + bottom - e.height) / 2 }
  }
  moveAll(s, list, target)
}

/** Equal gaps between elements, the outermost staying where they are. */
export function boardDistribute(s: ProjectStore, ids: string[], direction: "horizontal" | "vertical") {
  const horizontal = direction === "horizontal"
  const start = (e: ExcalidrawElement) => (horizontal ? e.x : e.y)
  const size = (e: ExcalidrawElement) => (horizontal ? e.width : e.height)
  const list = chosen(s, ids).sort((a, b) => start(a) - start(b))
  if (list.length < 3) throw new Error("distributing takes at least three elements")
  const last = list[list.length - 1]
  const gap = (start(last) + size(last) - start(list[0]) - list.reduce((sum, e) => sum + size(e), 0)) / (list.length - 1)
  const places = new Map<string, number>()
  let at = start(list[0])
  for (const e of list) {
    places.set(e.id, at)
    at += size(e) + gap
  }
  moveAll(s, list, (e) => (horizontal ? { x: places.get(e.id)! } : { y: places.get(e.id)! }))
}

/** Moves elements, their labels by the same distance. */
function moveAll(s: ProjectStore, list: ExcalidrawElement[], target: (e: ExcalidrawElement) => { x?: number; y?: number }) {
  const out: ExcalidrawElement[] = []
  for (const e of list) {
    const to = target(e)
    const dx = (to.x ?? e.x) - e.x
    const dy = (to.y ?? e.y) - e.y
    out.push(changed(e, { x: e.x + dx, y: e.y + dy }))
    for (const label of live(s)) if ((label as Mutable).containerId === e.id) out.push(changed(label, { x: label.x + dx, y: label.y + dy }))
  }
  commit(s, out)
}

export function boardGroup(s: ProjectStore, ids: string[]): string {
  const group = crypto.randomUUID()
  commit(s, withLabels(s, chosen(s, ids)).map((e) => changed(e, { groupIds: [...e.groupIds, group] })))
  return group
}

/** Takes the elements out of their outermost group. */
export function boardUngroup(s: ProjectStore, ids: string[]) {
  commit(s, withLabels(s, chosen(s, ids)).map((e) => changed(e, { groupIds: e.groupIds.slice(0, -1) })))
}

export function boardLock(s: ProjectStore, ids: string[], locked: boolean) {
  commit(s, withLabels(s, chosen(s, ids)).map((e) => changed(e, { locked })))
}

/** Copies elements with new ids, moved by (dx, dy); bindings to elements outside the copy are dropped. */
export function boardDuplicate(s: ProjectStore, ids: string[], dx = 20, dy = 20): string[] {
  const list = withLabels(s, chosen(s, ids))
  const fresh = new Map(list.map((e) => [e.id, crypto.randomUUID()]))
  const groups = new Map<string, string>()
  const copies = list.map((element) => {
    const e = element as Mutable
    const binding = (b: unknown) => {
      const target = fresh.get((b as { elementId?: string } | null)?.elementId ?? "")
      return target ? { ...(b as object), elementId: target } : null
    }
    return {
      ...e,
      id: fresh.get(e.id)!,
      x: e.x + dx,
      y: e.y + dy,
      index: null,
      version: 1,
      versionNonce: Math.floor(Math.random() * 2 ** 31),
      seed: Math.floor(Math.random() * 2 ** 31),
      updated: Date.now(),
      groupIds: e.groupIds.map((g) => groups.get(g) ?? groups.set(g, crypto.randomUUID()).get(g)!),
      boundElements: (e.boundElements ?? []).flatMap((b) => (fresh.has(b.id) ? [{ ...b, id: fresh.get(b.id)! }] : [])),
      ...("containerId" in e ? { containerId: fresh.get(e.containerId as string) ?? null } : {}),
      ...("startBinding" in e ? { startBinding: binding(e.startBinding), endBinding: binding(e.endBinding) } : {}),
    } as unknown as ExcalidrawElement
  })
  commit(s, copies)
  return copies.map((e) => e.id)
}

/** The scene as a .excalidraw file's JSON. */
export function boardExport(s: ProjectStore): string {
  return JSON.stringify({ type: "excalidraw", version: 2, source: "polycode", elements: live(s), appState: {}, files: Object.fromEntries(s.board.getMap("files").entries()) })
}

/** Puts a .excalidraw file's elements on the board, newest version winning; `replace` clears it first. */
export function boardImport(s: ProjectStore, scene: string, replace = false): number {
  const parsed = JSON.parse(scene) as { elements?: ExcalidrawElement[]; files?: Record<string, BinaryFileData> }
  if (!Array.isArray(parsed.elements)) throw new Error("not an Excalidraw scene: no elements")
  if (replace) boardClear(s)
  const elements = elementsOf(s)
  const files = s.board.getMap<BinaryFileData>("files")
  s.board.transact(() => {
    for (const e of parsed.elements!) {
      const current = elements.get(e.id)
      // A deleted or older one here must not win over what comes in.
      elements.set(e.id, current ? changed(e, { version: Math.max(current.version, e.version ?? 0) }) : e)
    }
    for (const f of Object.values(parsed.files ?? {})) files.set(f.id, f)
  })
  return parsed.elements.length
}

/** Named snapshots of the board, kept in this tab (the tool of mcp_excalidraw, for trying things out). */
const snapshots = new Map<string, string>()
export const boardSnapshot = (s: ProjectStore, name: string) => void snapshots.set(name, boardExport(s))
export function boardRestore(s: ProjectStore, name: string): number {
  const scene = snapshots.get(name)
  if (scene === undefined) throw new Error(`no snapshot ${name}: ${[...snapshots.keys()].join(", ") || "none yet"}`)
  return boardImport(s, scene, true)
}
