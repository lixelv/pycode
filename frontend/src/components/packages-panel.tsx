import { AlertCircle, Check, Loader2, Package, Plus, RotateCw, Trash2 } from "lucide-react"
import { useState, type FormEvent } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { parseSpec, type PackageEntry } from "@/hooks/use-packages"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"

const SUGGESTIONS = ["numpy", "pandas", "rich", "sympy", "tabulate", "colorama"]

interface PackagesPanelProps {
  packages: PackageEntry[]
  readOnly?: boolean
  onAdd: (spec: string) => void
  onRemove: (name: string) => void
  onRetry: (name: string) => void
}

export function PackagesPanel({ packages, readOnly = false, onAdd, onRemove, onRetry }: PackagesPanelProps) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-2xl font-semibold tracking-tight">{t("pkg.title")}</h2>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("pkg.text")}
            </p>
          </div>
          <Button onClick={() => setOpen(true)} disabled={readOnly}>
            <Plus /> {t("pkg.add")}
          </Button>
        </div>

        {packages.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-14 text-center">
            <Package className="size-6 text-muted-foreground" />
            <div className="text-sm font-medium">{t("pkg.empty")}</div>
            <p className="max-w-sm text-sm text-muted-foreground">
              {t("pkg.emptyText")}
            </p>
            <Button variant="outline" size="sm" onClick={() => setOpen(true)} disabled={readOnly}>
              <Plus /> {t("pkg.add")}
            </Button>
          </div>
        ) : (
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {packages.map((p) => (
              <li key={p.name} className="flex items-center gap-3 bg-card px-4 py-3">
                <StatusIcon status={p.status} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium">{p.name}</span>
                    {p.version && (
                      <Badge variant="outline" className="font-mono text-[11px] font-normal">
                        {p.version}
                      </Badge>
                    )}
                    <span className="text-xs text-muted-foreground">{p.requested ? t("pkg.pinned", { v: p.requested }) : t("pkg.latest")}</span>
                  </div>
                  <div className={cn("mt-0.5 text-xs", p.status === "error" ? "text-destructive" : "text-muted-foreground")}>
                    {p.status === "installing"
                      ? t("pkg.installing")
                      : p.status === "error"
                        ? p.error
                        : `import ${p.name.replace(/-/g, "_")}`}
                  </div>
                </div>
                {p.status === "error" && !readOnly && (
                  <Button variant="ghost" size="icon-sm" aria-label={t("pkg.retry", { name: p.name })} onClick={() => onRetry(p.name)}>
                    <RotateCw />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={readOnly}
                  aria-label={t("pkg.remove", { name: p.name })}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => onRemove(p.name)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-muted-foreground">
          {t("pkg.note")}
        </p>
      </div>

      <AddPackageDialog
        open={open}
        onOpenChange={setOpen}
        existing={packages.map((p) => p.name)}
        onAdd={(spec) => {
          onAdd(spec)
          setOpen(false)
        }}
      />
    </div>
  )
}

function StatusIcon({ status }: { status: PackageEntry["status"] }) {
  if (status === "installing") return <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
  if (status === "error") return <AlertCircle className="size-4 shrink-0 text-destructive" />
  return <Check className="size-4 shrink-0 text-success" />
}

function AddPackageDialog({
  open,
  onOpenChange,
  existing,
  onAdd,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existing: string[]
  onAdd: (spec: string) => void
}) {
  const { t } = useI18n()
  const [value, setValue] = useState("")
  const parsed = parseSpec(value)
  const error = value.trim() && !parsed ? t("pkg.dialog.invalid") : null

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!parsed) return
    onAdd(parsed.spec)
    setValue("")
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("pkg.add")}</DialogTitle>
            <DialogDescription>{t("pkg.dialog.text")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <label htmlFor="package-spec" className="text-sm font-medium">
              {t("pkg.dialog.label")}
            </label>
            <input
              id="package-spec"
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="requests  or  numpy==2.4.6"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!!error}
              className="h-9 rounded-md border border-input bg-background px-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 aria-invalid:border-destructive"
            />
            <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
              {error ??
                (parsed && existing.includes(parsed.name)
                  ? t("pkg.dialog.replaces", { name: parsed.name })
                  : t("pkg.dialog.format"))}
            </p>
            <div className="flex flex-wrap gap-1.5 pt-1">
              {SUGGESTIONS.filter((s) => !existing.includes(s)).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setValue(s)}
                  className="rounded-full border border-border px-2.5 py-0.5 font-mono text-xs text-muted-foreground hover:border-muted-foreground hover:text-foreground"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("btn.cancel")}
            </Button>
            <Button type="submit" disabled={!parsed}>
              {t("pkg.add")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
