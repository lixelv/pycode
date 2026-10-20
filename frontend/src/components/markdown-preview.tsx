import DOMPurify from "dompurify"
import { marked } from "marked"
import { X } from "lucide-react"
import { useMemo } from "react"

import { Button } from "@/components/ui/button"
import { useI18n } from "@/lib/i18n"

/** Rendered Markdown, always on the dark console surface. */
export function MarkdownPreview({ path, source, onClose }: { path: string; source: string; onClose: () => void }) {
  const { t } = useI18n()
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }) as string), [source])
  return (
    <section aria-label="Markdown preview" className="flex h-full flex-col bg-console text-console-foreground">
      <header className="flex h-9 shrink-0 items-center gap-3 border-b border-console-border px-3">
        <span className="text-[11px] font-medium tracking-wider text-console-muted uppercase">{t("preview.title")}</span>
        <span className="font-mono text-[11px] text-console-muted">{path}</span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={t("preview.close")}
          onClick={onClose}
          className="ml-auto text-console-muted hover:bg-white/10 hover:text-console-foreground dark:hover:bg-white/10"
        >
          <X />
        </Button>
      </header>
      <div className="markdown-body min-h-0 flex-1 overflow-auto px-6 py-5" dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  )
}
