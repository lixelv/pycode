import { CornerDownLeft, Eraser, Square, X } from "lucide-react"
import { memo, useEffect, useRef, type KeyboardEvent, type ReactNode } from "react"
import type * as Y from "yjs"

import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { isBusy, type Chunk, type ExitInfo, type RunStatus } from "@/hooks/use-runner"
import { useSharedDraft } from "@/hooks/use-shared-console"
import { stderrRuns } from "@/lib/console-lines"
import { translate, useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"

interface ConsolePanelProps {
  status: RunStatus
  chunks: Chunk[]
  exit: ExitInfo | null
  timeoutSec: number
  /** False for viewers of a read-only session. */
  canInput?: boolean
  /** Holds the input line being typed: shared, so everyone sees it as it is typed. */
  doc: Y.Doc
  onDraft: (text: string) => void
  onInput: (text: string) => void
  onEof: () => void
  onStop: () => void
  onClear: () => void
  onClose: () => void
  /** Shown in the header before the title (e.g. a switch to the web preview). */
  tabs?: ReactNode
  /** False while another tab of its group is shown: what is hidden cannot take focus. */
  visible?: boolean
}

function exitLabel(exit: ExitInfo, timeoutSec: number) {
  switch (exit.reason) {
    case "timeout":
      return translate("console.timeout", { n: timeoutSec })
    case "output_limit":
      return translate("console.outputLimit")
    case "killed":
      return translate("console.stopped")
    case "error":
      return exit.message ?? translate("console.error")
    default:
      return translate("console.exited", { code: exit.code ?? "?", t: exit.duration.toFixed(2) })
  }
}

function StatusPill({ status, exit, timeoutSec, canInput }: { status: RunStatus; exit: ExitInfo | null; timeoutSec: number; canInput: boolean }) {
  if (status === "waiting" && !canInput) {
    return (
      <span className="inline-flex items-center gap-2 text-[11px] text-console-muted">
        <span className="size-1.5 animate-pulse rounded-full bg-console-foreground" />
        {translate("console.waitingOwner")}
      </span>
    )
  }
  if (status === "waiting") {
    return (
      <span className="inline-flex items-center gap-2 rounded-full bg-console-foreground px-2.5 py-0.5 text-[11px] font-medium text-console">
        <span className="size-1.5 animate-pulse rounded-full bg-console" />
        {translate("console.waiting")}
      </span>
    )
  }
  if (status === "running" || status === "connecting" || status === "compiling") {
    return (
      <span className="inline-flex items-center gap-2 text-[11px] text-console-muted">
        <span className="size-1.5 animate-pulse rounded-full bg-console-foreground" />
        {translate(status === "compiling" ? "run.compiling" : status === "connecting" ? "console.starting" : "console.running")}
      </span>
    )
  }
  if (exit) {
    const ok = exit.reason === null && exit.code === 0
    return (
      <span className="inline-flex items-center gap-2 text-[11px] text-console-muted">
        <span className={cn("size-1.5 rounded-full", ok ? "bg-console-foreground" : "border border-console-foreground")} />
        {exitLabel(exit, timeoutSec)}
      </span>
    )
  }
  return null
}

export function ConsolePanel({
  status,
  chunks,
  exit,
  timeoutSec,
  canInput = true,
  doc,
  onDraft,
  onInput,
  onEof,
  onStop,
  onClear,
  onClose,
  tabs,
  visible = true,
}: ConsolePanelProps) {
  useI18n() // re-render on language change
  const draft = useSharedDraft(doc)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const waitingForInput = status === "waiting"
  const waiting = waitingForInput && canInput
  const active = isBusy(status)

  // Stick to the bottom while output streams in.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chunks, waiting, exit])

  useEffect(() => {
    if (waiting && visible) inputRef.current?.focus({ preventScroll: true })
  }, [waiting, visible])

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    // Enter that confirms an IME candidate only finishes the composition.
    if (e.nativeEvent.isComposing) return
    if (e.key === "Enter") {
      e.preventDefault()
      onInput(draft)
    } else if (e.key === "d" && e.ctrlKey && !draft) {
      e.preventDefault()
      onEof()
    } else if (e.key === "c" && e.ctrlKey) {
      e.preventDefault()
      onStop()
    }
  }

  return (
    <section
      aria-label="Console output"
      className="flex h-full flex-col bg-console font-mono text-console-foreground"
      onClick={() => waiting && inputRef.current?.focus()}
    >
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-console-border px-3">
        {tabs ?? <span className="text-[11px] font-medium tracking-wider text-console-muted uppercase">{translate("console.title")}</span>}
        <StatusPill status={status} exit={exit} timeoutSec={timeoutSec} canInput={canInput} />
        <div className="ml-auto flex items-center gap-0.5">
          {active && canInput && (
            <ConsoleButton label={translate("console.stop")} onClick={onStop}>
              <Square className="fill-current" />
            </ConsoleButton>
          )}
          <ConsoleButton label={translate("console.clear")} onClick={onClear}>
            <Eraser />
          </ConsoleButton>
          <ConsoleButton label={translate("console.hide")} onClick={onClose}>
            <X />
          </ConsoleButton>
        </div>
      </header>

      <div
        ref={scrollRef}
        role="log"
        aria-live="polite"
        className="min-h-0 flex-1 overflow-auto px-4 py-3 text-[13px] leading-[1.6]"
      >
        <pre className="font-mono break-words whitespace-pre-wrap">
          {chunks.map((chunk, i) => (
            <ChunkText key={i} kind={chunk.kind} text={chunk.text} />
          ))}
          {waiting && (
            <span className="inline-flex items-baseline">
              <span className="relative inline-block">
                <input
                  ref={inputRef}
                  value={draft}
                  onChange={(e) => onDraft(e.target.value)}
                  onKeyDown={onKeyDown}
                  aria-label={translate("console.input")}
                  spellCheck={false}
                  autoComplete="off"
                  className="bg-transparent p-0 font-mono font-semibold text-console-foreground caret-transparent outline-none"
                  style={{ width: `${Math.max(draft.length + 1, 1)}ch` }}
                />
              </span>
              <span aria-hidden className="console-caret -ml-[1ch] inline-block h-[1.15em] w-[1ch] translate-y-[0.2em] bg-console-foreground" />
            </span>
          )}
          {waitingForInput && !canInput && draft && <span className="font-semibold">{draft}</span>}
          {!active && exit && (
            <span className="text-console-muted">
              {chunks.length > 0 && !chunks[chunks.length - 1].text.endsWith("\n") ? "\n" : ""}
              {"\n"}— {exitLabel(exit, timeoutSec)}
            </span>
          )}
        </pre>
      </div>

      {waiting && (
        <footer className="flex h-8 shrink-0 items-center gap-2 border-t border-console-border px-3 text-[11px] text-console-muted">
          <CornerDownLeft className="size-3" />
          {translate("console.hint")}
        </footer>
      )}
    </section>
  )
}

// Memoised by value: the terminal is read anew each frame, and only its last chunk changes.
const ChunkText = memo(function ChunkText({ kind, text }: Chunk) {
  return (
    <span
      className={cn(
        kind === "stdin" && "font-semibold underline decoration-console-muted underline-offset-4",
        kind === "system" && "text-console-muted",
      )}
    >
      {kind === "stderr" ? <StderrText text={text} /> : text}
    </span>
  )
})

function ConsoleButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          onClick={(e) => {
            e.stopPropagation()
            onClick()
          }}
          className="text-console-muted hover:bg-white/10 hover:text-console-foreground dark:hover:bg-white/10 [&_svg:not([class*='size-'])]:size-3.5"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

function StderrText({ text }: { text: string }) {
  return (
    <>
      {stderrRuns(text).map((run, i) => (
        <span key={i} className={run.error ? "text-[#ff6166]" : undefined}>
          {run.text}
        </span>
      ))}
    </>
  )
}
