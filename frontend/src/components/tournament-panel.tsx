import { X } from "lucide-react"
import { useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import type { TournamentView } from "@/hooks/use-tournaments"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"

/** The standings of a tournament, one row per participant, live. */
export function TournamentPanel({ tournaments, tabs, onClose }: { tournaments: TournamentView[]; tabs: ReactNode; onClose: () => void }) {
  const { t } = useI18n()
  const [chosen, setChosen] = useState<string | null>(null)
  const current = tournaments.find((x) => x.id === chosen) ?? tournaments[0]
  return (
    <section aria-label={t("tournament.tab")} className="flex h-full flex-col bg-console text-console-foreground">
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-console-border px-3">
        {tabs}
        {tournaments.length > 1 ? (
          <div className="flex min-w-0 gap-1 overflow-x-auto">
            {tournaments.map((x) => (
              <button
                key={x.id}
                data-tournament={x.id}
                aria-pressed={x.id === current?.id}
                onClick={() => setChosen(x.id)}
                className={cn("shrink-0 rounded px-2 py-0.5 font-mono text-[11px]", x.id === current?.id ? "bg-white/10 text-console-foreground" : "text-console-muted hover:text-console-foreground")}
              >
                {x.id}
              </button>
            ))}
          </div>
        ) : (
          <span className="truncate font-mono text-[11px] text-console-muted">{current?.id}</span>
        )}
        <Button size="icon-xs" variant="ghost" aria-label={t("console.hide")} onClick={onClose} className="ml-auto text-console-muted hover:bg-white/10 hover:text-console-foreground">
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-2 font-mono text-[13px]">
        {current?.private && <div className="px-2 pb-2 text-[11px] text-console-muted">{t("tournament.private")}</div>}
        {current && !current.standings.length && <div className="p-2 text-console-muted">{t("tournament.empty")}</div>}
        {current && current.standings.length > 0 && (
          <table className="w-full">
            <thead className="text-left text-[11px] text-console-muted">
              <tr>
                <th className="px-2 py-1 font-medium">{t("tournament.place")}</th>
                <th className="px-2 py-1 font-medium">{t("tournament.name")}</th>
                {current.tasks.map((task) => (
                  <th key={task} className="px-2 py-1 text-right font-medium">
                    {task}
                  </th>
                ))}
                <th className="px-2 py-1 text-right font-medium">{t("tournament.total")}</th>
              </tr>
            </thead>
            <tbody>
              {current.standings.map((s) => (
                <tr key={s.userId}>
                  <td className="px-2 py-1 text-console-muted">{s.place}</td>
                  <td className="max-w-48 truncate px-2 py-1">{s.name}</td>
                  {current.tasks.map((task) => (
                    <td key={task} className="px-2 py-1 text-right">
                      {s.scores[task] ?? "—"}
                    </td>
                  ))}
                  <td className="px-2 py-1 text-right font-medium">{s.total}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}
