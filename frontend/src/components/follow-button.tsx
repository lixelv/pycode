import { ChevronDown, Eye, EyeOff } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import type { Peer } from "@/hooks/use-collab"
import { useI18n } from "@/lib/i18n"

/**
 * Follow mode: the first press follows the owner; while following, the
 * button opens a list to follow someone else or stop.
 */
export function FollowButton({
  peers,
  leaderId,
  onFollowOwner,
  onFollow,
  onStop,
}: {
  peers: Peer[]
  leaderId: number | null
  onFollowOwner: () => void
  onFollow: (clientId: number) => void
  onStop: () => void
}) {
  const { t } = useI18n()
  const others = peers.filter((p) => !p.isMe)
  if (leaderId === null) {
    return (
      <Button variant="ghost" size="sm" onClick={onFollowOwner} disabled={!others.length} className="text-muted-foreground" title={t("follow.owner")}>
        <Eye /> <span className="hidden lg:inline">{t("follow.btn")}</span>
      </Button>
    )
  }
  const leader = peers.find((p) => p.clientId === leaderId)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" aria-label={t("follow.following", { name: leader?.user.name ?? "…" })}>
          <span className="size-2 rounded-full" style={{ background: leader?.user.color ?? "currentColor" }} />
          <span className="hidden max-w-28 truncate lg:inline">{leader?.user.name ?? "…"}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onCloseAutoFocus={(e) => e.preventDefault()}>
        <DropdownMenuLabel>{t("follow.pick")}</DropdownMenuLabel>
        {others.map((p) => (
          <DropdownMenuItem key={p.clientId} onSelect={() => onFollow(p.clientId)}>
            <span className="size-2 rounded-full" style={{ background: p.user.color }} />
            <span className="font-mono text-xs">{p.user.name}</span>
            {p.clientId === leaderId && <span className="ml-auto text-xs text-muted-foreground">✓</span>}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onStop}>
          <EyeOff /> {t("follow.stop")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
