import { Check, ChevronDown, Copy, Link2, Loader2, LogOut, Plus, Power, Radio, X } from "lucide-react"
import { useCallback, useEffect, useState, type FormEvent } from "react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { Peer } from "@/hooks/use-collab"
import { addRole, formatCode, listCodes, type CollabProvider, type RoleCode } from "@/lib/collab/provider"
import { useI18n } from "@/lib/i18n"
import type { Level, Member } from "@/lib/project/access"
import { BUILT_IN, memberLabel, roleLabel } from "@/lib/roles"
import { rolesOf } from "@/lib/project/project"
import type { ProjectStore } from "@/lib/project/store"
import { cn } from "@/lib/utils"

interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  available: boolean | null
  provider: CollabProvider | null
  /** The project shown (its custom roles live in it). */
  store: ProjectStore
  peers: Peer[]
  onStart: (askName: boolean) => Promise<void>
  onJoin: (code: string) => Promise<void>
  onLeave: () => void
  onEnd: () => Promise<void>
}

const ROLE_NAME = /^[\p{L}\p{N}_-]{1,32}$/u

export function ShareDialog(props: ShareDialogProps) {
  const { open, onOpenChange, provider } = props
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        {provider ? <LiveSession {...props} provider={provider} /> : <StartOrJoin {...props} />}
      </DialogContent>
    </Dialog>
  )
}

function StartOrJoin({ available, store, onStart, onJoin, onOpenChange }: ShareDialogProps) {
  const { t } = useI18n()
  const [askName, setAskName] = useState(false)
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
        <CustomRoles store={store} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={askName} onChange={(e) => setAskName(e.target.checked)} className="size-4 accent-foreground" />
          {t("share.askName")}
        </label>
        <Button disabled={!available || busy !== null} onClick={() => void run("start", () => onStart(askName))}>
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
          className={INPUT + " flex-1 font-mono uppercase placeholder:normal-case"}
        />
        <Button type="submit" variant="outline" disabled={!available || !code.trim() || busy !== null}>
          {busy === "join" && <Loader2 className="animate-spin" />} {t("share.join")}
        </Button>
      </form>
    </div>
  )
}

const INPUT =
  "h-8 min-w-0 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"

/**
 * The project's custom roles (structure.roles): name and what they may do
 * with public files. `onAdded` lets a live session create the role's code.
 */
function CustomRoles({ store, onAdded }: { store: ProjectStore; onAdded?: (name: string, level: "read" | "write") => void }) {
  const { t } = useI18n()
  const [roles, setRoles] = useState<Record<string, "read" | "write">>({})
  const [name, setName] = useState("")
  const [level, setLevel] = useState<"read" | "write">("write")
  useEffect(() => {
    const map = rolesOf(store)
    const read = () => setRoles(map.toJSON() as Record<string, "read" | "write">)
    read()
    map.observe(read)
    return () => map.unobserve(read)
  }, [store])

  const valid = ROLE_NAME.test(name) && !BUILT_IN[name]
  const add = (e: FormEvent) => {
    e.preventDefault()
    if (!valid) return
    rolesOf(store).set(name, level)
    onAdded?.(name, level)
    setName("")
  }

  return (
    <div className="flex flex-col gap-2">
      {/* In a live session the roles are listed with their codes instead. */}
      {!onAdded && Object.keys(roles).length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {Object.entries(roles).map(([role, lvl]) => (
            <li key={role} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <span className="font-mono text-xs">{role}</span>
              <span className="text-xs text-muted-foreground">{t("share.publicLevel", { level: roleLabel(lvl) })}</span>
              <Button size="icon-xs" variant="ghost" className="ml-auto" aria-label={t("share.removeRole")} onClick={() => rolesOf(store).delete(role)}>
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value.trim())}
          placeholder={t("share.roleName")}
          aria-label={t("share.roleName")}
          aria-invalid={name !== "" && !valid}
          title={name !== "" && !valid ? t("share.roleBad") : undefined}
          className={cn(INPUT, "flex-1 font-mono aria-invalid:border-destructive")}
        />
        <Segmented value={level} onChange={setLevel} />
        <Button type="submit" variant="outline" size="sm" disabled={!valid}>
          <Plus /> {t("share.addRole")}
        </Button>
      </form>
    </div>
  )
}

function Segmented({ value, onChange }: { value: "read" | "write"; onChange: (v: "read" | "write") => void }) {
  return (
    <div role="radiogroup" className="inline-flex shrink-0 rounded-md border border-border bg-muted p-0.5">
      {(["read", "write"] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "rounded-[5px] px-2 py-0.5 text-xs font-medium transition-colors",
            value === v ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {roleLabel(v)}
        </button>
      ))}
    </div>
  )
}

function LiveSession({ provider, store, peers, onLeave, onEnd, onOpenChange }: ShareDialogProps & { provider: CollabProvider }) {
  const { t } = useI18n()
  const [ending, setEnding] = useState(false)
  const [codes, setCodes] = useState<RoleCode[] | null>(null)
  const admin = provider.isAdmin
  const customRoles = (codes ?? []).map((c) => c.role).filter((r) => !BUILT_IN[r])

  const refresh = useCallback(() => {
    if (admin) listCodes(provider.code).then((r) => setCodes(r.codes)).catch((err: Error) => toast.error(err.message))
  }, [admin, provider])
  useEffect(refresh, [refresh])

  const ORDER = ["admin", "write", "read"]
  const adminCode = codes?.find((c) => c.role === "admin")?.code
  const sorted = [...(codes ?? [])].sort((a, b) => {
    const ia = ORDER.indexOf(a.role)
    const ib = ORDER.indexOf(b.role)
    return (ia < 0 ? 9 : ia) - (ib < 0 ? 9 : ib) || a.role.localeCompare(b.role)
  })

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
            {memberLabel(provider.member)}
          </Badge>
        </DialogTitle>
        <DialogDescription>{admin ? t("share.rolesText") : t("share.linkText")}</DialogDescription>
      </DialogHeader>

      {admin ? (
        <section className="flex flex-col gap-2">
          <div className="text-sm font-medium">{t("share.roles")}</div>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {codes === null && (
              <li className="flex justify-center p-3">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </li>
            )}
            {sorted.map((c) => (
              <RoleRow key={c.role} code={c} />
            ))}
          </ul>
          {adminCode && (
            <div className="grid gap-1">
              <div className="text-xs font-medium">{t("share.mcp")}</div>
              <CopyField label="MCP" value={`${location.origin}/s/${adminCode}/mcp`} />
              <p className="text-xs text-muted-foreground">{t("share.mcpHint")}</p>
            </div>
          )}
          <CustomRoles
            store={store}
            onAdded={(name, level) =>
              addRole(provider.code, name, level)
                .then(refresh)
                .catch((err: Error) => toast.error(err.message))
            }
          />
        </section>
      ) : (
        <div className="grid gap-2">
          <CopyField label={t("share.link")} value={`${location.origin}/s/${provider.code}`} />
          <CopyField label={t("share.code")} value={formatCode(provider.code)} mono large />
        </div>
      )}

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
              <span className="ml-auto">
                {p.member && <MemberRoles me={provider.member} member={p.member} isMe={p.isMe} roles={customRoles} onSet={(level, roles) => provider.setRole(p.member!.peer, level, roles)} onKick={(ban) => provider.kick(p.member!.peer, ban)} />}
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
        {provider.member.owner && (
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

/**
 * A member's level and custom roles. An admin changes them for members
 * below admin (but cannot make admins); the owner for anyone but themself.
 */
function MemberRoles({
  me,
  member,
  isMe,
  roles,
  onSet,
  onKick,
}: {
  me: Member
  member: Member & { acting: boolean }
  isMe: boolean
  roles: string[]
  onSet: (level: Level, roles: string[]) => void
  onKick: (ban: boolean) => void
}) {
  const { t } = useI18n()
  const label = memberLabel(member, member.acting && !member.owner)
  const canEdit = !isMe && me.level === "admin" && !member.owner && (!!me.owner || member.level !== "admin")
  if (!canEdit) return <span className="text-xs text-muted-foreground">{label}</span>
  const levels: Level[] = me.owner ? ["read", "write", "admin"] : ["read", "write"]
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="xs" className="max-w-56 text-muted-foreground" aria-label={t("share.changeRole")}>
          <span className="truncate">{label}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel>{t("share.level")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={member.level} onValueChange={(v) => onSet(v as Level, [...member.roles])}>
          {levels.map((l) => (
            <DropdownMenuRadioItem key={l} value={l}>
              {roleLabel(l)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {roles.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("share.customRoles")}</DropdownMenuLabel>
            {roles.map((r) => (
              <DropdownMenuCheckboxItem
                key={r}
                checked={member.roles.includes(r)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(on) => onSet(member.level, on ? [...member.roles, r] : member.roles.filter((x) => x !== r))}
                className="font-mono text-xs"
              >
                {r}
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onKick(false)}>
          {t("share.kick")}
        </DropdownMenuItem>
        <DropdownMenuItem className="text-destructive focus:text-destructive" onSelect={() => onKick(true)}>
          {t("share.ban")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** One role's join code, with buttons to copy its link or the code. */
function RoleRow({ code }: { code: RoleCode }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState<"link" | "code" | null>(null)
  const copy = async (kind: "link" | "code") => {
    await navigator.clipboard.writeText(kind === "link" ? `${location.origin}/s/${code.code}` : formatCode(code.code))
    setCopied(kind)
    setTimeout(() => setCopied(null), 1500)
  }
  return (
    <li className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
      <span className={cn("min-w-0 truncate text-sm", !BUILT_IN[code.role] && "font-mono text-xs")}>{roleLabel(code.role)}</span>
      {!BUILT_IN[code.role] && <span className="text-xs text-muted-foreground">{roleLabel(code.level)}</span>}
      <span className="ml-auto font-mono text-sm tracking-wider">{formatCode(code.code)}</span>
      <Button size="icon-sm" variant="ghost" aria-label={t("share.copyLink")} title={t("share.copyLink")} onClick={() => void copy("link")}>
        {copied === "link" ? <Check /> : <Link2 />}
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label={t("share.copyCode")} title={t("share.copyCode")} onClick={() => void copy("code")}>
        {copied === "code" ? <Check /> : <Copy />}
      </Button>
    </li>
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
