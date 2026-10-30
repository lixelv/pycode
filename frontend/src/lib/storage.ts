const CODE_KEY = "python-coder:code"
const THEME_KEY = "polycode:theme"

export const DEFAULT_CODE = `# Welcome to polycode!
# Press Run (⌘/Ctrl + Enter) to execute, or Show tree to see the AST.

def greet(name: str) -> str:
    return f"Hello, {name}!"


name = input("What is your name? ")
print(greet(name))

squares = [n * n for n in range(1, 6)]
print("Squares:", squares)
`

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // Storage may be unavailable (private mode, quota); nothing to do.
  }
}

export const loadCode = () => read(CODE_KEY) ?? DEFAULT_CODE
export const saveCode = (code: string) => write(CODE_KEY, code)

export type Theme = "dark" | "light"
export const loadTheme = (): Theme => (read(THEME_KEY) === "light" ? "light" : "dark")
export const saveTheme = (theme: Theme) => write(THEME_KEY, theme)

// ---- moving data from the old names (pycode / python-coder) -------------------

type KeyStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">

// Kept under their old names: the legacy project migration reads them (project.ts).
const LEGACY_KEPT = new Set(["python-coder:code", "python-coder:packages"])

/** pycode:* and python-coder:* keys become polycode:*; a key that already exists under the new name wins. */
export function renameLocalKeys(storage: KeyStorage) {
  const keys: string[] = []
  for (let i = 0; i < storage.length; i++) keys.push(storage.key(i)!)
  for (const old of keys) {
    const rest = old.startsWith("pycode:") ? old.slice(7) : old.startsWith("python-coder:") && !LEGACY_KEPT.has(old) ? old.slice(13) : null
    if (rest === null) continue
    const value = storage.getItem(old)
    if (storage.getItem(`polycode:${rest}`) === null && value !== null) storage.setItem(`polycode:${rest}`, value)
    storage.removeItem(old)
  }
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })

type StoreCopy = { name: string; params: IDBObjectStoreParameters; indexes: { name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }[]; keys: IDBValidKey[]; values: unknown[] }

/**
 * Copies a database under a new name: the stores (with their key settings and
 * indexes) and every record with its key. The copy is one version-change
 * transaction, so it either completes or leaves nothing behind.
 */
async function copyDatabase(from: string, to: string) {
  const src = await done(indexedDB.open(from))
  const stores: StoreCopy[] = []
  try {
    const names = [...src.objectStoreNames]
    const tx = names.length ? src.transaction(names, "readonly") : null
    for (const name of names) {
      const store = tx!.objectStore(name)
      stores.push({
        name,
        params: { keyPath: store.keyPath, autoIncrement: store.autoIncrement },
        indexes: [...store.indexNames].map((n) => {
          const i = store.index(n)
          return { name: n, keyPath: i.keyPath, unique: i.unique, multiEntry: i.multiEntry }
        }),
        keys: await done(store.getAllKeys()),
        values: await done(store.getAll()),
      })
    }
  } finally {
    src.close()
  }
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(to, 1)
    req.onupgradeneeded = () => {
      for (const s of stores) {
        const store = req.result.createObjectStore(s.name, s.params)
        for (const { name, keyPath, ...options } of s.indexes) store.createIndex(name, keyPath, options)
        s.values.forEach((value, i) => (store.keyPath === null ? store.put(value, s.keys[i]) : store.put(value)))
      }
      req.transaction!.oncomplete = () => resolve()
      req.transaction!.onerror = req.transaction!.onabort = () => reject(req.transaction!.error)
    }
    req.onsuccess = () => req.result.close()
    req.onerror = () => reject(req.error)
  })
}

const dropDatabase = (name: string) =>
  new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name)
    req.onsuccess = req.onerror = req.onblocked = () => resolve() // blocked: deleted once other tabs let go
  })

/** Run once before the app starts: moves old localStorage keys and IndexedDB databases to the polycode names. */
export async function migrateStorage() {
  try {
    renameLocalKeys(localStorage)
  } catch {
    // storage unavailable
  }
  try {
    if (!indexedDB.databases) return
    const names = (await indexedDB.databases()).map((d) => d.name!)
    for (const old of names.filter((n) => n.startsWith("pycode:"))) {
      const next = `polycode:${old.slice(7)}`
      if (names.includes(next)) continue
      try {
        await copyDatabase(old, next)
      } catch {
        continue // keep the old one
      }
      await dropDatabase(old)
    }
  } catch {
    // old data stays where it is
  }
}
