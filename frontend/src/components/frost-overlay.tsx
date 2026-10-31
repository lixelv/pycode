import { Snowflake } from "lucide-react"
import { useEffect, useState } from "react"

import { useI18n } from "@/lib/i18n"

/**
 * Frost creeping in from the screen's edges while the class is frozen: it
 * grows thick for a moment, settles into a thin rim, and melts away when the
 * freeze ends. Purely decorative (pointer-events: none).
 */
export function FrostOverlay({ frozen, admin }: { frozen: boolean; admin: boolean }) {
  const { t } = useI18n()
  const [phase, setPhase] = useState<"off" | "on" | "melting">(frozen ? "on" : "off")
  useEffect(() => {
    if (frozen) {
      setPhase("on")
      return
    }
    setPhase((p) => (p === "on" ? "melting" : p))
    const timer = window.setTimeout(() => setPhase((p) => (p === "melting" ? "off" : p)), 700)
    return () => window.clearTimeout(timer)
  }, [frozen])
  if (phase === "off") return null

  return (
    <div aria-hidden={admin} className="frost" data-phase={phase}>
      <div className="frost-glass" />
      <svg className="frost-layer" width="100%" height="100%">
        <filter id="frost-fine">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="3" seed="7" />
          <feColorMatrix values="0 0 0 0 0.9  0 0 0 0 0.96  0 0 0 0 1  0 0 0 2.2 -0.85" />
        </filter>
        <filter id="frost-crystals">
          <feTurbulence type="turbulence" baseFrequency="0.012 0.03" numOctaves="4" seed="3" />
          <feColorMatrix values="0 0 0 0 0.95  0 0 0 0 0.98  0 0 0 0 1  0 0 0 3.2 -1.2" />
        </filter>
        <rect width="100%" height="100%" filter="url(#frost-crystals)" />
        <rect width="100%" height="100%" filter="url(#frost-fine)" />
      </svg>
      {!admin && (
        <div role="status" className="frost-badge">
          <Snowflake className="size-3.5" /> {t("freeze.badge")}
        </div>
      )}
    </div>
  )
}
