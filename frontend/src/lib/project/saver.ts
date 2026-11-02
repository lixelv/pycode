import * as Y from "yjs"

import { getBlob, putBlob, sha256 } from "./blobs"
import type { ProjectCloud } from "./cloud"
import { foldersOf, metasOf, tournamentsOf } from "./project"
import { hiddenManifest, type ManifestEntry, placementOf, publicStructure } from "./publish"
import type { FileMeta, ProjectStore } from "./store"

export type SaveStatus = "saved" | "saving" | "unsaved"

/** A document waits this long after its last edit. */
const DEBOUNCE_MS = 2000
const RETRY_MIN_MS = 5000
const RETRY_MAX_MS = 30_000
const LOAD_PARALLEL = 8
const MOVABLE = /^(public|hidden|private)\/(f|b|t)\//

const STRUCTURE = "structure"

const statusOf = (err: unknown) => (err as { status?: number }).status

function tableKey(id: string) {
  const bytes = new TextEncoder().encode(id)
  return `private/t/${btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}.ybin.gz`
}

const fileKey = (where: string, meta: FileMeta) => (meta.kind === "text" ? `${where}/f/${meta.id}.ybin.gz` : `${where}/b/${meta.hash}.gz`)

function sameVector(a: Map<number, number>, b: Map<number, number>) {
  if (a.size !== b.size) return false
  for (const [client, clock] of a) if (b.get(client) !== clock) return false
  return true
}

const parseManifest = (bytes: Uint8Array | null): ManifestEntry[] => (bytes ? (JSON.parse(new TextDecoder().decode(bytes)) as ManifestEntry[]) : [])

/**
 * Keeps a project in S3. Only the room's saver has a token and writes; the others
 * load and wait. The prefix of each object follows its file's visibility.
 */
export class ProjectSaver {
  status: SaveStatus = "saved"
  /** The project was deleted: nothing is written, the local copy is erased. */
  gone = false

  private readonly store: ProjectStore
  private readonly cloud: ProjectCloud
  private token: string | null = null
  /** Another tab of the owner saves: this one's edits reach it through the room. */
  private elsewhere = false
  /** A tab that just became the saver cannot trust what it knew of S3: another tab wrote there. */
  private needSync = false
  private loaded = false
  private known = new Set<string>()
  /** Paths of the sealed manifest, with their ids: what the server must be told about. */
  private sealedKnown = new Map<string, string>()
  private placements = new Map<string, string>()
  private readonly dirty = new Set<string>()
  private readonly due = new Set<string>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryDelay = RETRY_MIN_MS
  private failed: unknown = null
  private running: Promise<void> | null = null
  private readonly listeners = new Set<() => void>()
  private readonly detach: (() => void)[] = []

  constructor(_projectId: string, store: ProjectStore, cloud: ProjectCloud) {
    this.store = store
    this.cloud = cloud
    for (const id of store.ids()) this.watch(id, store.doc(id))
    this.detach.push(store.onDoc((id, doc) => this.watch(id, doc)))
  }

  /** S3 has this project's structure: what the browser holds is no longer the only copy. */
  get stored() {
    return this.known.has("private/structure.ybin.gz")
  }

  /** Called when status or gone change. */
  on(fn: () => void) {
    this.listeners.add(fn)
    return () => void this.listeners.delete(fn)
  }

  destroy() {
    this.detach.forEach((fn) => fn())
    this.timers.forEach((t) => clearTimeout(t))
    if (this.retryTimer) clearTimeout(this.retryTimer)
  }

  private watch(id: string, doc: Y.Doc) {
    if (id === "runtime") return
    const onUpdate = (_update: Uint8Array, origin: unknown) => {
      // What load merges in is not an edit; an edit made meanwhile is.
      if (origin !== this) this.touched(id)
    }
    doc.on("update", onUpdate)
    this.detach.push(() => doc.off("update", onUpdate))
  }

  private setStatus(status: SaveStatus) {
    if (this.status === status) return
    this.status = status
    this.listeners.forEach((fn) => fn())
  }

  private touched(id: string) {
    if (this.gone) return
    this.dirty.add(id)
    this.statusWithoutToken()
    if (id === STRUCTURE && this.placementsChanged()) {
      // Who may read a file changed: that does not wait.
      this.dropTimer(id)
      this.due.add(id)
      void this.pump()
      return
    }
    this.schedule(id)
  }

  private dropTimer(id: string) {
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
  }

  private schedule(id: string) {
    this.dropTimer(id)
    if (!this.token) return
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id)
        this.due.add(id)
        void this.pump()
      }, DEBOUNCE_MS),
    )
  }

  private currentPlacements() {
    const folders = foldersOf(this.store).toJSON() as Record<string, string>
    const out = new Map<string, string>()
    metasOf(this.store).forEach((meta, path) => out.set(meta.id, placementOf(path, meta, folders)))
    return out
  }

  private placementsChanged() {
    const next = this.currentPlacements()
    let changed = false
    for (const [id, where] of next) {
      const before = this.placements.get(id)
      if (before !== undefined && before !== where) changed = true
    }
    this.placements = next
    return changed
  }

  /**
   * The tab becomes the saver (or stops being it): what waited goes out.
   * `elsewhere`: without a token, whether another tab of the owner is saving.
   */
  setToken(token: string | null, elsewhere = false) {
    if (this.gone) return
    const gained = !!token && token !== this.token
    this.token = token
    this.elsewhere = elsewhere
    if (!token) {
      for (const id of [...this.timers.keys()]) this.dropTimer(id)
      this.statusWithoutToken()
      return
    }
    if (gained) this.needSync = true
    for (const id of this.dirty) if (!this.timers.has(id) && !this.due.has(id)) this.schedule(id)
    void this.pump()
  }

  /** Nobody is saving what changed here: the footer must not say otherwise. */
  private statusWithoutToken() {
    if (this.token) return
    this.setStatus(this.dirty.size && !this.elsewhere ? "unsaved" : "saved")
  }

  // ---- opening ---------------------------------------------------------------------

  /** Merges S3's copy into the local one. Without either, or for a deleted project, it throws. */
  async load(): Promise<void> {
    try {
      await this.read()
      this.loaded = true
      this.placements = this.currentPlacements()
      // A file hidden during the read has not moved: the check after a load finds it.
      this.needSync = true
    } catch (err) {
      if (statusOf(err) === 404) {
        await this.lost()
        throw err
      }
      if (metasOf(this.store).size === 0) throw err
      this.setStatus("unsaved")
      this.retryLoad()
      return
    }
    this.afterLoad()
  }

  private retryLoad() {
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.load().catch(() => {})
    }, this.nextDelay())
  }

  private nextDelay() {
    const delay = this.retryDelay
    this.retryDelay = Math.min(RETRY_MAX_MS, delay * 2)
    return delay
  }

  private afterLoad() {
    this.setStatus(this.failed ? "unsaved" : "saved")
    for (const id of this.dirty) if (this.token) this.schedule(id)
    this.statusWithoutToken()
    if (this.token) void this.pump()
    void this.fetchBlobs()
  }

  private applyFrom(doc: Y.Doc, id: string, bytes: Uint8Array | null) {
    if (bytes) Y.applyUpdate(doc, bytes, this)
    const local = Y.decodeStateVector(Y.encodeStateVector(doc))
    if (bytes ? !sameVector(local, Y.decodeStateVector(Y.encodeStateVectorFromUpdate(bytes))) : local.size > 0) this.dirty.add(id)
  }

  private async read() {
    this.known = new Set((await this.cloud.keys()).map((k) => k.key))
    const has = (key: string) => this.known.has(key)
    this.sealedKnown = new Map(parseManifest(has("sealed/manifest.json.gz") ? await this.cloud.get("sealed/manifest.json.gz") : null).map((e) => [e.path, e.id]))

    if (has("private/structure.ybin.gz")) {
      this.applyFrom(this.store.structure, STRUCTURE, await this.cloud.get("private/structure.ybin.gz"))
    } else {
      // A copy's first opening: public/structure is a clean document, only ever read while there is no structure of our own.
      const start = has("public/structure.ybin.gz") ? await this.cloud.get("public/structure.ybin.gz") : null
      // Only into nothing: a first save cut short leaves this file too, with our real structure here.
      if (start && metasOf(this.store).size === 0) Y.applyUpdate(this.store.structure, start, this)
      const sealed = parseManifest(has("sealed/manifest.json.gz") ? await this.cloud.get("sealed/manifest.json.gz") : null)
      const metas = metasOf(this.store)
      this.store.structure.transact(() => {
        for (const { path, ...entry } of sealed) if (!metas.has(path)) metas.set(path, { ...entry, sealed: true })
      }, this)
      if (start || sealed.length || metas.size) this.dirty.add(STRUCTURE)
    }

    const jobs: [string, Y.Doc, string | undefined][] = [["board", this.store.board, has("public/board.ybin.gz") ? "public/board.ybin.gz" : undefined]]
    metasOf(this.store).forEach((meta) => {
      if (meta.kind !== "text" || meta.sealed) return
      const key = ["public", "hidden", "private"].map((w) => fileKey(w, meta)).find(has)
      jobs.push([`f:${meta.id}`, this.store.doc(`f:${meta.id}`), key])
    })
    for (const id of tournamentsOf(this.store).keys()) jobs.push([`t:${id}`, this.store.doc(`t:${id}`), has(tableKey(id)) ? tableKey(id) : undefined])
    let next = 0
    await Promise.all(
      Array.from({ length: LOAD_PARALLEL }, async () => {
        while (next < jobs.length) {
          const [id, doc, key] = jobs[next++]
          this.applyFrom(doc, id, key ? await this.cloud.get(key) : null)
        }
      }),
    )
  }

  /** Binary files this browser lacks. Never a sealed one: those come only for a check. */
  private async fetchBlobs() {
    const metas = [...metasOf(this.store).values()].filter((m) => m.kind === "binary" && m.hash && !m.sealed)
    for (const meta of metas) {
      if (this.gone) return
      if (await getBlob(meta.hash!)) continue
      const key = ["public", "hidden", "private"].map((w) => fileKey(w, meta)).find((k) => this.known.has(k))
      const bytes = key ? await this.cloud.get(key).catch(() => null) : null
      if (bytes && (await sha256(bytes)) === meta.hash) await putBlob(bytes, meta.hash!)
    }
  }

  // ---- saving ----------------------------------------------------------------------

  /** Writes everything now; rejects if that fails. A tab that is not the saver has nothing to do. */
  async flush(): Promise<void> {
    if (this.gone) throw new Error("the project was deleted")
    if (!this.token) return
    if (!this.loaded) throw new Error("the project could not be read from storage")
    for (const id of [...this.timers.keys()]) this.dropTimer(id)
    await this.running
    this.dirty.forEach((id) => this.due.add(id))
    this.failed = null
    await this.pump()
    if (this.gone) throw new Error("the project was deleted")
    if (this.failed) throw this.failed
    if (!this.token) throw new NotSaverError() // lost on the way: nothing says it was written
  }

  /** Before going public: the real list of objects, so nothing stays where it must not. */
  async reconcile(): Promise<void> {
    // Only the saver can vouch for what lies under public/.
    if (!this.token) throw new NotSaverError()
    await this.flush()
    if (!this.token) throw new NotSaverError()
    this.known = new Set((await this.cloud.keys()).map((k) => k.key))
    this.dirty.add(STRUCTURE)
    await this.flush()
  }

  private pump(): Promise<void> {
    if (!this.running) {
      this.running = this.drain().finally(() => {
        this.running = null
      })
    }
    return this.running
  }

  /** The real list of objects; anything out of place makes the structure's save due. */
  private async syncKnown() {
    this.needSync = false
    this.known = new Set((await this.cloud.keys()).map((k) => k.key))
    const wanted = this.wantedKeys()
    // Something missing while the structure waits its turn is only that edit, on its way.
    const stale = [...this.known].some((key) => MOVABLE.test(key) && !wanted.has(key)) || (!this.dirty.has(STRUCTURE) && [...wanted].some((key) => !this.known.has(key)))
    if (stale) {
      this.dirty.add(STRUCTURE)
      this.dropTimer(STRUCTURE)
      this.due.add(STRUCTURE)
    }
  }

  private async drain() {
    if (!this.token) this.statusWithoutToken()
    if (!this.token || !this.loaded || this.gone) return
    if (this.needSync) {
      try {
        await this.syncKnown()
      } catch (err) {
        this.needSync = true
        await this.onFailure(err)
        return
      }
    }
    while (this.due.size && this.token && this.loaded && !this.gone) {
      this.setStatus("saving")
      const batch = [...this.due].sort((a) => (a === STRUCTURE ? -1 : 1))
      this.due.clear()
      batch.forEach((id) => this.dirty.delete(id))
      try {
        for (const id of batch) await this.save(id)
        this.retryDelay = RETRY_MIN_MS
        this.failed = null
      } catch (err) {
        batch.forEach((id) => this.dirty.add(id))
        await this.onFailure(err)
        return
      }
    }
    if (!this.gone && !this.failed && this.loaded) this.setStatus("saved")
  }

  private async onFailure(err: unknown) {
    this.failed = err
    if (statusOf(err) === 404) {
      await this.lost()
      return
    }
    this.setStatus("unsaved")
    this.statusWithoutToken() // the saver moved on while this was in flight
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.failed = null
      this.dirty.forEach((id) => this.due.add(id))
      void this.pump()
    }, this.nextDelay())
  }

  private async lost() {
    if (this.gone) return
    this.gone = true
    this.detach.forEach((fn) => fn())
    this.timers.forEach((t) => clearTimeout(t))
    this.timers.clear()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.dirty.clear()
    this.due.clear()
    await this.store.clearStorage()
    this.listeners.forEach((fn) => fn())
  }

  private async write(key: string, bytes: Uint8Array) {
    await this.cloud.put(key, bytes, this.token!)
    this.known.add(key)
  }

  private async save(id: string) {
    if (id === STRUCTURE) return this.saveStructure()
    if (id === "board") return this.write("public/board.ybin.gz", Y.encodeStateAsUpdate(this.store.board))
    if (id.startsWith("t:")) {
      if (tournamentsOf(this.store).has(id.slice(2))) await this.write(tableKey(id.slice(2)), Y.encodeStateAsUpdate(this.store.doc(id)))
      return
    }
    const fileId = id.slice(2)
    const folders = foldersOf(this.store).toJSON() as Record<string, string>
    for (const [path, meta] of metasOf(this.store).entries()) {
      if (meta.id !== fileId || meta.sealed) continue
      await this.write(fileKey(placementOf(path, meta, folders), meta), Y.encodeStateAsUpdate(this.store.doc(id)))
      return
    }
  }

  /** Every object that should lie under a movable prefix. */
  private wantedKeys() {
    const folders = foldersOf(this.store).toJSON() as Record<string, string>
    const wanted = new Set<string>()
    for (const [path, meta] of metasOf(this.store).entries()) {
      if (!meta.sealed && (meta.kind === "text" || meta.hash)) wanted.add(fileKey(placementOf(path, meta, folders), meta))
    }
    for (const id of tournamentsOf(this.store).keys()) wanted.add(tableKey(id))
    return wanted
  }

  /**
   * New objects first, then what names them, then the old ones: a file being hidden is
   * never missing. The owner's full structure goes last: until it is there the next
   * opening sees this save as unfinished, so a closed tab cannot leave a file public.
   */
  private async saveStructure() {
    const folders = foldersOf(this.store).toJSON() as Record<string, string>
    const wanted = new Set<string>()
    for (const [path, meta] of metasOf(this.store).entries()) {
      if (meta.sealed || (meta.kind === "binary" && !meta.hash)) continue
      const key = fileKey(placementOf(path, meta, folders), meta)
      if (wanted.has(key)) continue
      wanted.add(key)
      if (this.known.has(key)) continue
      const bytes = meta.kind === "text" ? Y.encodeStateAsUpdate(this.store.doc(`f:${meta.id}`)) : await this.blobBytes(meta)
      if (bytes) await this.write(key, bytes)
    }
    for (const id of tournamentsOf(this.store).keys()) {
      const key = tableKey(id)
      wanted.add(key)
      if (!this.known.has(key)) await this.write(key, Y.encodeStateAsUpdate(this.store.doc(`t:${id}`)))
    }
    await this.write("public/structure.ybin.gz", publicStructure(this.store.structure))
    await this.write("hidden/manifest.json.gz", new TextEncoder().encode(JSON.stringify(hiddenManifest(this.store.structure))))

    const sealedIds = new Set([...metasOf(this.store).values()].filter((m) => m.sealed).map((m) => m.id))
    const replaced = [...this.sealedKnown].filter(([, id]) => !sealedIds.has(id)).map(([path]) => path)
    if (replaced.length) {
      await this.cloud.dropSealed(replaced, this.token!)
      replaced.forEach((path) => this.sealedKnown.delete(path))
    }
    for (const key of [...this.known]) {
      if (!MOVABLE.test(key) || wanted.has(key)) continue
      await this.cloud.remove(key, this.token!)
      this.known.delete(key)
    }
    await this.write("private/structure.ybin.gz", Y.encodeStateAsUpdate(this.store.structure))
  }

  /** A binary file's bytes: from this browser, else from where it lay in S3. */
  private async blobBytes(meta: FileMeta) {
    const local = await getBlob(meta.hash!)
    if (local) return local
    const from = ["public", "hidden", "private"].map((w) => fileKey(w, meta)).find((k) => this.known.has(k))
    return from ? this.cloud.get(from) : null
  }
}

/** Going public needs the tab that saves: only it can vouch for what lies under public/. */
export class NotSaverError extends Error {
  constructor() {
    super("not the saver")
  }
}

/** A stranger's view of a public project: its public objects, in memory. */
export async function loadPublic(store: ProjectStore, cloud: ProjectCloud) {
  const structure = await cloud.get("public/structure.ybin.gz")
  if (structure) Y.applyUpdate(store.structure, structure)
  const board = await cloud.get("public/board.ybin.gz")
  if (board) Y.applyUpdate(store.board, board)
  const metas = [...metasOf(store).values()]
  await Promise.all(
    metas.map(async (meta) => {
      if (meta.kind === "text") {
        const text = await cloud.get(fileKey("public", meta))
        if (text) Y.applyUpdate(store.doc(`f:${meta.id}`), text)
      } else if (meta.hash && !(await getBlob(meta.hash))) {
        const bytes = await cloud.get(fileKey("public", meta))
        // The blob store is shared and keyed by hash: a stranger's project must not fill it with other bytes.
        if (bytes && (await sha256(bytes)) === meta.hash) await putBlob(bytes, meta.hash)
      }
    }),
  )
}

/** A sealed test's text, for one check: it goes to the check and nowhere else. */
export async function sealedText(cloud: ProjectCloud, meta: FileMeta): Promise<string | null> {
  const bytes = await cloud.get(fileKey("sealed", meta))
  if (!bytes) return null
  const doc = new Y.Doc()
  Y.applyUpdate(doc, bytes)
  const text = doc.getText("t").toString()
  doc.destroy()
  return text
}
