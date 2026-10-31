import { ArrowDownToLine, ArrowUpFromLine, Play, Redo2, Square, X } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { useI18n, type MessageKey } from "@/lib/i18n"
import type { DebugCommand, DebugState } from "@/workers/protocol"

const ACTIONS: [DebugCommand, MessageKey, ReactNode][] = [
  ["continue", "debug.continue", <Play key="c" className="fill-current" />],
  ["next", "debug.next", <Redo2 key="n" />],
  ["step", "debug.step", <ArrowDownToLine key="s" />],
  ["return", "debug.return", <ArrowUpFromLine key="r" />],
  ["stop", "debug.stop", <Square key="x" className="fill-current" />],
]

/**
 * Where the debugged program stopped: its variables and call stack, with
 * the stepping buttons for the person running it (the others watch).
 */
export function DebugPanel({
  state,
  canControl,
  tabs,
  onCommand,
  onOpen,
  onClose,
}: {
  /** null while the program runs between stops. */
  state: DebugState | null
  canControl: boolean
  tabs: ReactNode
  onCommand: (command: DebugCommand) => void
  onOpen: (file: string, line: number) => void
  onClose: () => void
}) {
  const { t } = useI18n()
  const vars = Object.entries(state?.vars ?? {})
  return (
    <section aria-label={t("debug.tab")} className="flex h-full flex-col bg-console text-console-foreground">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-console-border px-3">
        {tabs}
        <div className="ml-3 flex items-center gap-0.5">
          {ACTIONS.map(([command, label, icon]) => (
            <Button
              key={command}
              size="icon-xs"
              variant="ghost"
              aria-label={t(label)}
              title={t(label)}
              disabled={!canControl || (!state && command !== "stop")}
              onClick={() => onCommand(command)}
              className="text-console-muted hover:bg-white/10 hover:text-console-foreground [&_svg]:size-3.5"
            >
              {icon}
            </Button>
          ))}
        </div>
        <Button size="icon-xs" variant="ghost" aria-label={t("console.hide")} onClick={onClose} className="ml-auto text-console-muted hover:bg-white/10 hover:text-console-foreground">
          <X />
        </Button>
      </header>
      {!state ? (
        <div className="p-3 text-sm text-console-muted">{t("debug.running")}</div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[2fr_1fr] divide-x divide-console-border font-mono text-[12.5px]">
          <div className="min-h-0 overflow-auto p-2">
            <div className="px-1 pb-1 text-[11px] tracking-wider text-console-muted uppercase">{t("debug.vars")}</div>
            {vars.length === 0 && <div className="px-1 text-console-muted">{t("debug.none")}</div>}
            <table className="w-full">
              <tbody>
                {vars.map(([name, value]) => (
                  <tr key={name} className="align-top">
                    <td className="py-0.5 pr-3 pl-1 whitespace-nowrap text-[#c792ea]">{name}</td>
                    <td className="py-0.5 break-all text-console-foreground">{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="min-h-0 overflow-auto p-2">
            <div className="px-1 pb-1 text-[11px] tracking-wider text-console-muted uppercase">{t("debug.stack")}</div>
            <ol>
              {[...state.stack].reverse().map((f, i) => (
                <li key={i}>
                  <button onClick={() => onOpen(f.file, f.line)} className="w-full rounded px-1 py-0.5 text-left hover:bg-white/10">
                    <span className={i === 0 ? "text-[#f5d90a]" : ""}>{f.name === "<module>" ? f.file : f.name}</span>
                    <span className="text-console-muted"> :{f.line}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}
    </section>
  )
}
