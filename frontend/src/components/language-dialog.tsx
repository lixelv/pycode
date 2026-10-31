import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useI18n } from "@/lib/i18n"
import type { ProjectLanguage } from "@/lib/project/project"

const CHOICES: { lang: ProjectLanguage; name: string; file: string }[] = [
  { lang: "python", name: "Python", file: "main.py" },
  { lang: "cpp", name: "C++", file: "main.cpp" },
]

/** The language of a new project. Closing it keeps Python. */
export function LanguageDialog({ open, onChoose }: { open: boolean; onChoose: (lang: ProjectLanguage) => void }) {
  const { t } = useI18n()
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onChoose("python")}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("language.title")}</DialogTitle>
          <DialogDescription>{t("language.text")}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {CHOICES.map(({ lang, name, file }) => (
            <button
              key={lang}
              type="button"
              data-language={lang}
              onClick={() => onChoose(lang)}
              className="flex flex-col items-start gap-1 rounded-lg border border-border bg-background p-4 text-left outline-none transition-colors hover:border-foreground/40 hover:bg-accent focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
            >
              <span className="text-base font-semibold">{name}</span>
              <span className="font-mono text-xs text-muted-foreground">{file}</span>
              <span className="text-xs text-muted-foreground">{t(lang === "python" ? "language.python" : "language.cpp")}</span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
