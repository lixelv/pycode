import { IndexeddbPersistence } from "y-indexeddb"
import * as Y from "yjs"

/** One entry of `structure.files`: what a path holds. The content lives elsewhere. */
export interface FileMeta {
  id: string
  kind: "text" | "binary"
  size: number
  /** sha256 of a binary file's bytes (kept in the blob store). */
  hash?: string
  mime?: string
  protected?: true
  hidden?: true
}

/*
 * A project is a set of Y.Docs, each shared and checked on its own:
 *   structure  files (path -> FileMeta), dirs, packages, roles, folders, state
 *   runtime    terminal, run, debug
 *   board      the whiteboard
 *   f:<id>     one text file ("t": Y.Text)
 * All of them use the same client id, so "who did this" is one number.
 */
export class ProjectStore {
  readonly structure: Y.Doc
  readonly runtime: Y.Doc
  readonly board: Y.Doc
  ready: Promise<void>
  private readonly docs = new Map<string, Y.Doc>()
  private readonly stores = new Map<string, IndexeddbPersistence>()
  private readonly listeners = new Set<(docId: string, doc: Y.Doc) => void>()
  private readonly persist: boolean

  constructor(persist: boolean) {
    this.persist = persist
    this.structure = this.open("structure")
    this.runtime = this.open("runtime")
    this.board = this.open("board")
    const metas = this.structure.getMap<FileMeta>("files")
    metas.observe(() => this.follow())
    this.ready = Promise.all([...this.stores.values()].map((p) => p.whenSynced)).then(async () => {
      this.follow()
      await Promise.all([...this.stores.values()].map((p) => p.whenSynced))
    })
  }

  get clientID() {
    return this.structure.clientID
  }

  /** The document with this id, created (and loaded, when persisted) on first use. */
  doc(docId: string): Y.Doc {
    return this.docs.get(docId) ?? this.open(docId)
  }

  has(docId: string) {
    return this.docs.has(docId)
  }

  ids(): string[] {
    return [...this.docs.keys()]
  }

  /** Called for every document created from now on. */
  onDoc(fn: (docId: string, doc: Y.Doc) => void) {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Forgets everything stored for this project (the documents stay usable in memory). */
  async clearStorage() {
    await Promise.all([...this.stores.values()].map((p) => p.clearData()))
    this.stores.clear()
  }

  destroy() {
    this.stores.forEach((p) => void p.destroy())
    this.docs.forEach((d) => d.destroy())
    this.docs.clear()
    this.listeners.clear()
  }

  private open(docId: string): Y.Doc {
    const doc = new Y.Doc()
    if (this.structure) doc.clientID = this.structure.clientID
    this.docs.set(docId, doc)
    if (this.persist) this.stores.set(docId, new IndexeddbPersistence(`polycode:${docId}`, doc))
    this.listeners.forEach((fn) => fn(docId, doc))
    return doc
  }

  /** Text documents follow structure.files: one per text file, dropped with the file. */
  private follow() {
    const live = new Set<string>()
    this.structure.getMap<FileMeta>("files").forEach((meta) => {
      if (meta.kind === "text") live.add(`f:${meta.id}`)
    })
    for (const id of live) if (!this.docs.has(id)) this.open(id)
    for (const [id, doc] of this.docs) {
      if (!id.startsWith("f:") || live.has(id)) continue
      this.docs.delete(id)
      const store = this.stores.get(id)
      this.stores.delete(id)
      void store?.clearData()
      doc.destroy()
    }
  }
}
