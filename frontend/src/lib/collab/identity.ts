/**
 * A user's colour from their UUID taken as a 128-bit number:
 *   hue        = id % 256          (a byte spread over the colour wheel)
 *   saturation = 255 - (id >> 8) % 128   (255..128, i.e. 100%..50%)
 * Lightness is fixed so every colour reads on black and on white.
 */
export function colorFor(id: string): string {
  const n = BigInt(`0x${id.replace(/-/g, "") || "0"}`)
  const hue = (Number(n % 256n) / 256) * 360
  const saturation = (255 - Number((n >> 8n) % 128n)) / 255
  return hslToHex(hue, saturation, 0.6)
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l)
  const channel = (k: number) => {
    const t = (k + h / 30) % 12
    const v = l - a * Math.max(-1, Math.min(t - 3, 9 - t, 1))
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0")
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

/** A short, stable label from the id (last 4 hex digits). */
export function nameFor(id: string): string {
  return `User ${id.replace(/-/g, "").slice(-4).toUpperCase()}`
}

export interface Me {
  id: string
}

let me: Promise<Me | null> | null = null

/** Asks the backend who we are; the first request also sets the id cookie. */
export function fetchMe(): Promise<Me | null> {
  me ??= fetch("/api/me", { credentials: "same-origin" })
    .then((r) => (r.ok ? (r.json() as Promise<Me>) : null))
    .catch(() => null)
  return me
}
