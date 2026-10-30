/*
 * Binary files (images, PDFs, …) are kept by content: sha256 -> bytes, in
 * the IndexedDB database "polycode:blobs". Peers fetch missing ones from each
 * other (CollabProvider.fetchBlob); the project only stores the hash.
 */

const DB = "polycode:blobs"
const memory = new Map<string, Uint8Array>() // where IndexedDB is not available (tests)

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

let db: Promise<IDBDatabase> | null = null
function open(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === "undefined") return null
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore("blobs")
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return db
}

function request<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open()!.then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const req = fn(d.transaction("blobs", mode).objectStore("blobs"))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

/** Stores bytes; returns their hash. */
export async function putBlob(bytes: Uint8Array, hash?: string): Promise<string> {
  hash ??= await sha256(bytes)
  if (!open()) memory.set(hash, bytes)
  else await request("readwrite", (s) => s.put(bytes, hash))
  return hash
}

export async function getBlob(hash: string): Promise<Uint8Array | null> {
  if (!open()) return memory.get(hash) ?? null
  return ((await request("readonly", (s) => s.get(hash))) as Uint8Array | undefined) ?? null
}

/** A binary file's bytes: from this browser, or fetched from the session. */
export async function ensureBlob(hash: string, fetch?: (hash: string) => Promise<Uint8Array>): Promise<Uint8Array> {
  const local = await getBlob(hash)
  if (local) return local
  if (!fetch) throw new Error("This file's content is not in this browser.")
  return fetch(hash)
}
