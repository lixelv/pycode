import { Check, Copy, Eye, Loader2, LogOut, Pencil, Power, Radio } from "lucide-react"
import { useState, type FormEvent } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import type { Peer } from "@/hooks/use-collab"
import { formatCode, type CollabProvider, type Role, type SessionMode } from "@/lib/collab/provider"
import { useI18n, type MessageKey } from "@/lib/i18n"
import { cn } from "@/lib/utils"

interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  available: boolean | null
  provider: CollabProvider | null
  peers: Peer[]
  onStart: (mode: SessionMode) => Promise<void>
  onJoin: (code: string) => Promise<void>
  onLeave: () => void
  onEnd: () => Promise<void>
}

const ROLE_LABEL: Record<Role, MessageKey> = { owner: "share.owner", editor: "share.editor", viewer: "share.viewer" }

export function ShareDialog(props: ShareDialogProps) {
  const { open, onOpenChange, provider } = props
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {provider ? <LiveSession {...props} provider={provider} /> : <StartOrJoin {...props} />}
      </DialogContent>
    </Dialog>
  )
}

function StartOrJoin({ available, onStart, onJoin, onOpenChange }: ShareDialogProps) {
  const { t } = useI18n()
  const [mode, setMode] = useState<SessionMode>("read_write")
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState<"start" | "join" | null>(null)

  const run = async (kind: "start" | "join", fn: () => Promise<void>) => {
    setBusy(kind)
    try {
      await fn()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const join = (e: FormEvent) => {
    e.preventDefault()
    if (code.trim()) void run("join", async () => {
      await onJoin(code)
      onOpenChange(true)
    })
  }

  return (
    <div className="flex flex-col gap-6">
      <DialogHeader>
        <DialogTitle>{t("share.title")}</DialogTitle>
        <DialogDescription>{t("share.text")}</DialogDescription>
      </DialogHeader>

      {available === false && (
        <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t("share.unavailable")}
        </p>
      )}

      <section className="flex flex-col gap-3">
        <div className="text-sm font-medium">{t("share.start")}</div>
        <div role="radiogroup" className="grid grid-cols-2 gap-2">
          {(
            [
              ["read_write", Pencil, t("share.rw"), t("share.rwText")],
              ["read_only", Eye, t("share.ro"), t("share.roText")],
            ] as const
          ).map(([value, Icon, title, text]) => (
            <button
              key={value}
              role="radio"
              aria-checked={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "flex flex-col gap-1 rounded-lg border p-3 text-left transition-colors",
                mode === value ? "border-foreground bg-accent" : "border-border hover:border-muted-foreground",
              )}
            >
              <span className="flex items-center gap-2 text-sm font-medium">
                <Icon className="size-4" /> {title}
              </span>
              <span className="text-xs text-muted-foreground">{text}</span>
            </button>
          ))}
        </div>
        <Button disabled={!available || busy !== null} onClick={() => void run("start", () => onStart(mode))}>
          {busy === "start" ? <Loader2 className="animate-spin" /> : <Radio />} {t("share.startBtn")}
        </Button>
      </section>

      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" /> {t("share.or")} <span className="h-px flex-1 bg-border" />
      </div>

      <form onSubmit={join} className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={t("share.codePlaceholder")}
          spellCheck={false}
          autoComplete="off"
          aria-label="Session code or link"
          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-3 font-mono text-sm uppercase outline-none placeholder:normal-case focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
        />
        <Button type="submit" variant="outline" disabled={!available || !code.trim() || busy !== null}>
          {busy === "join" && <Loader2 className="animate-spin" />} {t("share.join")}
        </Button>
      </form>
    </div>
  )
}

function LiveSession({ provider, peers, onLeave, onEnd, onOpenChange }: ShareDialogProps & { provider: CollabProvider }) {
  const { t } = useI18n()
  const link = `${location.origin}/s/${provider.code}`
  const isOwner = provider.role === "owner"
  const [ending, setEnding] = useState(false)

  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-success" />
          </span>
          {t("share.title")}
          <Badge variant="outline" className="ml-1 font-normal">
            {provider.session.mode === "read_only" ? t("share.ro") : t("share.rw")}
          </Badge>
        </DialogTitle>
        <DialogDescription>{t("share.linkText")}</DialogDescription>
      </DialogHeader>

      <div className="grid gap-2">
        <CopyField label={t("share.link")} value={link} />
        <CopyField label={t("share.code")} value={formatCode(provider.code)} mono large />
      </div>

      <section className="flex flex-col gap-2">
        <div className="text-sm font-medium">{t("share.members", { n: peers.length })}</div>
        <ul className="max-h-48 divide-y divide-border overflow-auto rounded-lg border border-border">
          {peers.map((p) => (
            <li key={p.clientId} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="size-2.5 rounded-full" style={{ background: p.user.color }} />
              <span className="font-mono text-xs">{p.user.name}</span>
              {p.isMe && <span className="text-xs text-muted-foreground">{t("share.you")}</span>}
              {!p.isMe && p.link && (
                <span
                  title={p.link === "direct" ? t("share.direct") : t("share.relay")}
                  className="rounded-full border border-border px-1.5 text-[10px] text-muted-foreground"
                >
                  {p.link === "direct" ? "P2P" : "relay"}
                </span>
              )}
              <span className="ml-auto text-xs text-muted-foreground">
                {t(p.user.id === provider.session.ownerId ? ROLE_LABEL.owner : provider.session.mode === "read_only" ? ROLE_LABEL.viewer : ROLE_LABEL.editor)}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => {
            onLeave()
            onOpenChange(false)
          }}
        >
          <LogOut /> {t("share.leave")}
        </Button>
        {isOwner && (
          <Button
            variant="destructive"
            disabled={ending}
            onClick={async () => {
              setEnding(true)
              try {
                await onEnd()
                onOpenChange(false)
              } catch (err) {
                toast.error((err as Error).message)
              } finally {
                setEnding(false)
              }
            }}
          >
            {ending ? <Loader2 className="animate-spin" /> : <Power />} {t("share.end")}
          </Button>
        )}
      </div>
    </div>
  )
}

function CopyField({ label, value, mono, large }: { label: string; value: string; mono?: boolean; large?: boolean }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 py-1.5 pr-1.5 pl-3">
      <span className="w-10 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={cn("min-w-0 flex-1 truncate", mono ? "font-mono" : "text-sm", large && "text-lg font-semibold tracking-widest")}>
        {value}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={async () => {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        }}
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  )
}
