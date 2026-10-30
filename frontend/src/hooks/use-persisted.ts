import { useEffect, useState } from "react"

/**
 * State kept in this browser's localStorage as JSON (the fallback when it is
 * missing, unreadable or storage is unavailable).
 */
export function usePersisted<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? fallback : (JSON.parse(raw) as T)
    } catch {
      return fallback
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // storage unavailable
    }
  }, [key, value])
  return [value, setValue] as const
}
