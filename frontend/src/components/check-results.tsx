import { CircleCheck, CircleMinus, CircleX, Loader2, X } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { allPassed, maxPoints, type CheckTournamentInfo } from "@/lib/tournament"
import type { CheckResult } from "@/workers/protocol"

export interface CheckState {
  path: string
  results: CheckResult[] | null // null: still checking
  error?: string
  tournament?: CheckTournamentInfo
  /** A tournament's run that did not go into the table. */
  unrecorded?: boolean
}

/** The result of checking a solution: one line per test, green or red. */
export function CheckResults({ check, tabs, onClose }: { check: CheckState; tabs: ReactNode; onClose: () => void }) {
  const { t } = useI18n()
  const passed = check.results?.filter((r) => r.ok).length ?? 0
  const total = check.results?.length ?? 0
  const score = maxPoints(check.results?.filter((r) => r.ok) ?? [])
  const max = check.tournament?.max ?? 0
  const complete = check.tournament ? allPassed(check.results ?? []) : passed === total
  return (
    <section aria-label={t("check.title")} className="flex h-full flex-col bg-console text-console-foreground">
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-console-border px-3">
        {tabs}
        <span className="truncate font-mono text-[11px] text-console-muted">{check.path}</span>
        {check.results && !check.error && (
          <span className={cn("rounded-full px-2 text-[11px] font-medium", complete ? "bg-[#62c073]/15 text-[#62c073]" : "bg-[#ff6166]/15 text-[#ff6166]")}>
            {check.tournament ? t("tournament.summary", { score, max }) : t("check.summary", { passed, total })}
          </span>
        )}
        <Button size="icon-xs" variant="ghost" aria-label={t("console.hide")} onClick={onClose} className="ml-auto text-console-muted hover:bg-white/10 hover:text-console-foreground">
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[13px]">
        {!check.results && !check.error && (
          <div className="flex items-center gap-2 p-2 text-console-muted">
            <Loader2 className="size-4 animate-spin" /> {t("check.running")}
          </div>
        )}
        {check.error && <div className="whitespace-pre-wrap p-2 text-[#ff6166]">{check.error}</div>}
        {check.results?.length === 0 && !check.error && <div className="p-2 text-console-muted">{t("check.none")}</div>}
        {check.unrecorded && <div className="p-2 text-console-muted">{t("tournament.unrecorded")}</div>}
        <ul>
          {check.results?.map((r) => (
            <li key={r.name} data-skipped={r.skipped ? "true" : undefined} className={cn("flex items-start gap-2 rounded px-2 py-1", r.skipped && "text-console-muted")}>
              {r.skipped ? (
                <CircleMinus className="mt-0.5 size-4 shrink-0" />
              ) : r.ok ? (
                <CircleCheck className="mt-0.5 size-4 shrink-0 text-[#62c073]" />
              ) : (
                <CircleX className="mt-0.5 size-4 shrink-0 text-[#ff6166]" />
              )}
              <span>{r.name}</span>
              {r.skipped && <span>— {t("check.skipped")}</span>}
              {r.message && <span className="text-[#ff6166]">— {r.message}</span>}
              {(r.time !== undefined || r.memory !== undefined) && (
                <span title={t("check.measures")} className="ml-auto shrink-0 pl-2 text-console-muted">
                  {[r.time !== undefined && `${r.time.toFixed(2)} s`, r.memory !== undefined && `${(r.memory / 1e6).toFixed(1)} MB`].filter(Boolean).join(" · ")}
                </span>
              )}
              {check.tournament && r.points !== undefined && (
                <span data-points className={cn("shrink-0 pl-2", r.ok ? "text-[#62c073]" : "text-console-muted", r.time === undefined && r.memory === undefined && "ml-auto")}>
                  {r.ok ? `+${r.points}` : r.points}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
