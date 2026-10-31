import { useState, type FormEvent } from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useI18n } from "@/lib/i18n"

/** Asks for the name shown to the others in a session that wants one. */
export function NameDialog({ initial, onSubmit }: { initial: string | null; onSubmit: ((name: string) => void) | null }) {
  const { t } = useI18n()
  const [name, setName] = useState(initial ?? "")
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (name.trim()) onSubmit?.(name.trim().slice(0, 40))
  }
  return (
    <Dialog open={!!onSubmit}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false} onEscapeKeyDown={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{t("name.title")}</DialogTitle>
            <DialogDescription>{t("name.text")}</DialogDescription>
          </DialogHeader>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            aria-label={t("name.title")}
            placeholder={t("name.placeholder")}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
          />
          <DialogFooter>
            <Button type="submit" disabled={!name.trim()}>
              {t("name.join")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
