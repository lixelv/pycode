import { FolderTree, Network, Paintbrush, Play, Radio, Square, TerminalSquare } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react"
import { toast } from "sonner"

import { AstDialog } from "@/components/ast-dialog"
import { CodeEditor, type EditorInstance } from "@/components/code-editor"
import { ConfirmDialog, type ConfirmRequest } from "@/components/confirm-dialog"
import { ConsolePanel } from "@/components/console-panel"
import { FileTree } from "@/components/file-tree"
import { MarkdownPreview } from "@/components/markdown-preview"
import { PackagesPanel } from "@/components/packages-panel"
import { RemoteCursorStyles } from "@/components/remote-cursors"
import { ShareDialog } from "@/components/share-dialog"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Toaster } from "@/components/ui/sonner"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useCollab } from "@/hooks/use-collab"
import { usePackages } from "@/hooks/use-packages"
import { RUN_TIMEOUT_SEC, useRunner, type ExitInfo, type RunEvent, type RunStatus } from "@/hooks/use-runner"
import { useSharedConsole } from "@/hooks/use-shared-console"
import { toEditorColumn, type AstLoc } from "@/lib/ast"
import { appendTerminal, readRun, resetRun, setDraft, setRunStatus, sharedPackages, sharedTerminal } from "@/lib/collab/doc"
import {
  createDir,
  createFile,
  DEFAULT_FILE,
  deletePath,
  downloadBlob,
  exportZip,
  filesOf,
  importZip,
  languageOf,
  localProject,
  renamePath,
  replaceProject,
  resetProject,
  snapshotFiles,
} from "@/lib/project/project"
import { setLang, translate, useI18n } from "@/lib/i18n"
import { format, ruffVersion, type Diagnostic } from "@/lib/ruff"
import { cn } from "@/lib/utils"

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = IS_MAC ? "⌘" : "Ctrl"
const THEME = "dark" as const

type View = "editor" | "packages"

/** Waits for the local project (IndexedDB) before showing the workspace. */
export default function App() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    document.documentElement.classList.add("dark")
    document.documentElement.style.colorScheme = "dark"
    localProject().ready.then(() => setReady(true))
  }, [])
  if (!ready) return <div className="h-full bg-background" />
  return <Workspace />
}

function Workspace() {
  const { lang, t } = useI18n()
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleHeight, setConsoleHeight] = useState(0.38)
  const [treeOpen, setTreeOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(true)
  const [filesWidth, setFilesWidth] = useState(() => {
    try {
      return Number(localStorage.getItem("python-coder:files-width")) || 240
    } catch {
      return 240
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem("python-coder:files-width", String(filesWidth))
    } catch {
      // storage unavailable
    }
  }, [filesWidth])
  const [view, setView] = useState<View>("editor")
  const [ruff, setRuff] = useState<string | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [preview, setPreview] = useState<string | null>(null) // markdown file shown in the console area
  const [text, setText] = useState("")
  const editor = useRef<EditorInstance | null>(null)
  const split = useRef<HTMLDivElement>(null)

  // ---- project & session ------------------------------------------------------
  const collab = useCollab()
  const provider = collab.provider
  const doc = provider?.doc ?? localProject().doc
  const awareness = provider?.awareness ?? null
  const canWrite = !provider || provider.canWrite
  const isGuest = !!provider && provider.doc !== localProject().doc

  const [files, setFiles] = useState<string[]>(() => [...filesOf(doc).keys()])
  useEffect(() => {
    const map = filesOf(doc)
    const read = () => setFiles([...map.keys()].sort())
    read()
    map.observe(read)
    return () => map.unobserve(read)
  }, [doc])

  const [active, setActive] = useState(DEFAULT_FILE)
  // Keep the open file valid (deleted, or another project after joining/leaving).
  useEffect(() => {
    if (files.length && !files.includes(active)) setActive(files.includes(DEFAULT_FILE) ? DEFAULT_FILE : files[0])
  }, [files, active])
  const activeExists = files.includes(active)
  const language = languageOf(active)

  useEffect(() => {
    ruffVersion().then(setRuff).catch(() => {})
  }, [])

  // ---- running ------------------------------------------------------------------
  const sharedConsole = useSharedConsole(doc, awareness)
  const docRef = useRef(doc)
  useEffect(() => {
    docRef.current = doc
  }, [doc])

  /** Our own run is mirrored into the project's console (shared in a session). */
  const mirrorRun = useCallback((event: RunEvent) => {
    const d = docRef.current
    if (readRun(d).executorClient !== d.clientID) return // someone else took over
    if (event.type === "output") appendTerminal(d, event.kind, event.text)
    else if (event.type === "status") setRunStatus(d, event.status)
    else if (event.type === "exit") setRunStatus(d, "finished", event.exit)
  }, [])

  const runner = useRunner({ onRateLimited: (message) => toast.warning(message), onEvent: mirrorRun })
  const runnerRef = useRef(runner)
  useEffect(() => {
    runnerRef.current = runner
  })
  const packagesArray = useMemo(() => sharedPackages(doc), [doc])
  const pkgs = usePackages(packagesArray)

  // Input and Stop from other members reach us when we are the one running.
  useEffect(() => {
    if (!provider) return
    return provider.on("signal", (signal) => {
      if (readRun(provider.doc).executorClient !== provider.doc.clientID) return
      if (signal.type === "stdin") runnerRef.current.sendInput(signal.text)
      else if (signal.type === "eof") runnerRef.current.sendEof()
      else if (signal.type === "stop") runnerRef.current.stop()
    })
  }, [provider])

  // Everyone sees the console as soon as someone runs the program.
  const sharedStatus = sharedConsole.status
  useEffect(() => {
    if (sharedStatus !== "idle" && sharedStatus !== "finished") {
      setPreview(null)
      setConsoleOpen(true)
    }
  }, [sharedStatus])

  const executorClient = sharedConsole.executorClient
  const amExecutor = executorClient === null || executorClient === doc.clientID
  const consoleView: { status: RunStatus; exit: ExitInfo | null } = sharedConsole.executorGone
    ? { status: "finished", exit: { code: null, duration: 0, reason: "error", message: t("console.executorLeft") } }
    : { status: sharedConsole.status, exit: sharedConsole.exit }
  const consoleActive = consoleView.status === "connecting" || consoleView.status === "running" || consoleView.status === "waiting"

  const sendInput = useCallback(
    (line: string) => {
      setDraft(doc, "")
      if (amExecutor) runner.sendInput(line)
      else provider?.signal({ type: "stdin", to: executorClient!, text: line })
    },
    [doc, amExecutor, executorClient, provider, runner],
  )
  const sendEof = useCallback(() => {
    if (amExecutor) runner.sendEof()
    else provider?.signal({ type: "eof", to: executorClient! })
  }, [amExecutor, executorClient, provider, runner])
  const stop = useCallback(() => {
    if (amExecutor) runner.stop()
    else provider?.signal({ type: "stop", to: executorClient! })
  }, [amExecutor, executorClient, provider, runner])

  const runnable = language === "python" || language === "markdown"

  const run = useCallback(() => {
    if (!activeExists) return
    setView("editor")
    if (language === "markdown") {
      setPreview(active)
      setConsoleOpen(true)
      return
    }
    if (language !== "python") {
      toast.message(t("toast.onlyPython"))
      return
    }
    if (!canWrite) return
    setPreview(null)
    setConsoleOpen(true)
    // We become the one running the project's program; a run going on
    // elsewhere is stopped (its owner stops mirroring when we take over).
    const prev = readRun(doc)
    const busy = prev.status === "running" || prev.status === "waiting" || prev.status === "connecting"
    if (provider && busy && prev.executorClient !== null && prev.executorClient !== doc.clientID) {
      provider.signal({ type: "stop", to: prev.executorClient })
    }
    resetRun(doc, collab.me ?? "local")
    runner.run(snapshotFiles(doc), active, pkgs.activeSpecs)
  }, [activeExists, language, active, canWrite, doc, provider, collab.me, runner, pkgs.activeSpecs])

  // ---- project actions ----------------------------------------------------------
  const download = useCallback(() => {
    downloadBlob(exportZip(doc), provider ? `python-coder-${provider.code}.zip` : "python-coder-project.zip")
  }, [doc, provider])

  const upload = useCallback(
    async (file: File) => {
      let content: ReturnType<typeof importZip>
      try {
        content = importZip(new Uint8Array(await file.arrayBuffer()))
      } catch {
        toast.error(t("toast.badZip"))
        return
      }
      const count = Object.keys(content.files).length
      setConfirm({
        title: t("confirm.zip.title"),
        description: t("confirm.zip.text", { name: file.name, n: count, whose: t(provider ? "confirm.zip.whoseSession" : "confirm.zip.whoseYour") }),
        action: t("confirm.zip.action"),
        destructive: true,
        onConfirm: () => {
          replaceProject(doc, content.files, content.dirs, readPackages())
          const first = Object.keys(content.files).sort((a, b) => Number(b.endsWith(".py")) - Number(a.endsWith(".py")) || a.localeCompare(b))[0]
          setActive(content.files[DEFAULT_FILE] !== undefined ? DEFAULT_FILE : first ?? DEFAULT_FILE)
          toast.success(t("toast.opened", { name: file.name }))
        },
      })
      function readPackages() {
        return sharedPackages(doc).toArray()
      }
    },
    [doc, provider],
  )

  const reset = useCallback(() => {
    setConfirm({
      title: t("confirm.reset.title"),
      description: isGuest ? t("confirm.reset.guest") : t("confirm.reset.own"),
      action: t("confirm.reset.action"),
      destructive: true,
      onConfirm: () => {
        resetProject(localProject().doc)
        if (!isGuest) setActive(DEFAULT_FILE)
        toast.success(t("toast.reset"))
      },
    })
  }, [isGuest])

  const createEntry = useCallback(
    (path: string, kind: "file" | "dir") => {
      if (kind === "dir") createDir(doc, path)
      else {
        createFile(doc, path)
        setActive(path)
        setView("editor")
      }
    },
    [doc],
  )

  const deleteEntry = useCallback((path: string) => deletePath(doc, path), [doc])

  const renameEntry = useCallback(
    (from: string, to: string) => {
      const map = renamePath(doc, from, to)
      setActive((current) => map(current))
    },
    [doc],
  )

  const formatCode = useCallback(async () => {
    const ed = editor.current
    const model = ed?.getModel()
    if (!ed || !model) return
    try {
      const current = model.getValue()
      const formatted = language === "json" ? JSON.stringify(JSON.parse(current), null, 2) + "\n" : await format(current)
      if (formatted === current) return
      ed.pushUndoStop()
      ed.executeEdits("format", [{ range: model.getFullModelRange(), text: formatted }])
      ed.pushUndoStop()
    } catch {
      toast.error(t("toast.fixSyntax"))
    }
  }, [language])

  const reveal = useCallback((loc: AstLoc) => {
    setTreeOpen(false)
    const ed = editor.current
    if (!ed) return
    const current = ed.getValue()
    const range = {
      startLineNumber: loc.line,
      startColumn: toEditorColumn(current, loc.line, loc.col),
      endLineNumber: loc.endLine,
      endColumn: toEditorColumn(current, loc.endLine, loc.endCol),
    }
    // Wait for the dialog to release focus before selecting.
    setTimeout(() => {
      ed.setSelection(range)
      ed.revealRangeInCenter(range)
      ed.focus()
    }, 50)
  }, [])

  // Global shortcuts (the editor handles them itself while focused).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === "Enter") {
        e.preventDefault()
        run()
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault()
        download()
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [run, download])

  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault()
    const container = split.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    const onMove = (ev: PointerEvent) => {
      const ratio = (rect.bottom - ev.clientY) / rect.height
      setConsoleHeight(Math.min(0.8, Math.max(0.15, ratio)))
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.cursor = ""
    }
    document.body.style.cursor = "row-resize"
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  /** Drag the file panel's edge; dragging it almost shut collapses the panel. */
  const startFilesResize = (e: ReactPointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = filesOpen ? filesWidth : 0
    const onMove = (ev: PointerEvent) => {
      const width = startWidth + ev.clientX - startX
      if (width < 120) setFilesOpen(false)
      else {
        setFilesOpen(true)
        setFilesWidth(Math.min(480, Math.max(160, width)))
      }
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      document.body.style.cursor = ""
    }
    document.body.style.cursor = "col-resize"
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  const errors = diagnostics.length
  const previewText = preview && preview === active ? text : preview ? (filesOf(doc).get(preview)?.toString() ?? "") : ""

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full w-full flex-col overflow-hidden bg-background">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3">
          <div className="flex min-w-0 items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={filesOpen ? "secondary" : "ghost"}
                  size="icon-sm"
                  aria-label="Toggle files"
                  aria-pressed={filesOpen}
                  onClick={() => setFilesOpen((o) => !o)}
                >
                  <FolderTree />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{filesOpen ? t("header.files.hide") : t("header.files.show")}</TooltipContent>
            </Tooltip>
            <h1 className="min-w-0 truncate font-mono text-sm font-medium" title={active}>
              {activeExists ? <Breadcrumb path={active} /> : <span className="text-muted-foreground">{t("header.noFile")}</span>}
            </h1>
            <nav role="tablist" aria-label="View" className="ml-2 inline-flex shrink-0 rounded-md border border-border bg-muted p-0.5">
              {(
                [
                  ["editor", t("tab.code")],
                  ["packages", t("tab.packages")],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={view === value}
                  onClick={() => setView(value)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
                    view === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                  {value === "packages" && pkgs.packages.length > 0 && (
                    <span className="rounded-full bg-foreground/10 px-1.5 font-mono text-[10px]">{pkgs.packages.length}</span>
                  )}
                </button>
              ))}
            </nav>
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={formatCode}
                  disabled={!canWrite || (language !== "python" && language !== "json")}
                  className="hidden text-muted-foreground sm:inline-flex"
                >
                  <Paintbrush /> {t("btn.format")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{language === "json" ? t("btn.format.json") : t("btn.format.ruff")}</TooltipContent>
            </Tooltip>
            <Button variant="outline" size="sm" onClick={() => setTreeOpen(true)} disabled={language !== "python"}>
              <Network /> <span className="hidden sm:inline">{t("btn.tree")}</span>
            </Button>
            <span aria-hidden className="mx-1 h-5 w-px self-center bg-border" />
            <ShareButton live={!!provider} peers={collab.peers} readOnly={provider?.session.mode === "read_only"} onClick={() => setShareOpen(true)} />
            {consoleActive && canWrite && language === "python" ? (
              <Button size="sm" variant="secondary" onClick={stop} className="min-w-24">
                <Square className="fill-current" /> {t("btn.stop")}
              </Button>
            ) : (
              <Button size="sm" onClick={run} disabled={!runnable || (language === "python" && !canWrite)} className="min-w-24">
                <Play className="fill-current" /> {language === "markdown" ? t("btn.preview") : t("btn.run")}
                <Kbd className="ml-1 hidden h-4 bg-primary-foreground/15 px-1 text-[10px] text-primary-foreground sm:inline-flex">{MOD}↵</Kbd>
              </Button>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {filesOpen && (
            <div style={{ width: filesWidth }} className="h-full min-w-0 shrink-0">
              <FileTree
                doc={doc}
                active={active}
                readOnly={!canWrite}
                peers={collab.peers}
                onOpen={(path) => {
                  setActive(path)
                  setView("editor")
                }}
                onCreate={createEntry}
                onDelete={deleteEntry}
              onRename={renameEntry}
                onDownload={download}
                onUpload={upload}
                onReset={reset}
              />
            </div>
          )}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize files panel"
            onPointerDown={startFilesResize}
            onDoubleClick={() => setFilesOpen((o) => !o)}
            className="group relative z-10 w-px shrink-0 cursor-col-resize"
          >
            {/* The visible border: 1px, three times wider while hovered or dragged. */}
            <div className="absolute inset-y-0 left-0 w-px bg-border transition-[width] duration-150 group-hover:w-[3px] group-active:w-[3px]" />
            {/* Transparent, wider hit area so the edge is easy to grab. */}
            <div className="absolute inset-y-0 -right-2 -left-2 cursor-col-resize" />
          </div>

          {view === "packages" && (
            <main className="min-h-0 min-w-0 flex-1">
              <PackagesPanel packages={pkgs.packages} readOnly={!canWrite} onAdd={pkgs.add} onRemove={pkgs.remove} onRetry={pkgs.retry} />
            </main>
          )}
          {/* The editor stays mounted (hidden) so its state survives tab switches. */}
          <main ref={split} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", view !== "editor" && "hidden")}>
            <div className="relative min-h-0 flex-1">
              <CodeEditor
                doc={doc}
                path={active}
                available={activeExists}
                awareness={awareness}
                readOnly={!canWrite}
                theme={THEME}
                onText={setText}
                onDiagnostics={setDiagnostics}
                onCursor={(line, column) => setCursor({ line, column })}
                onRun={run}
                onSave={download}
                onMount={(ed) => (editor.current = ed)}
              />
              {!activeExists && (
                <div className="absolute inset-0 flex items-center justify-center bg-background text-sm text-muted-foreground">
                  {isGuest ? t("editor.waitingProject") : t("editor.createFile")}
                </div>
              )}
            </div>

            {consoleOpen && (
              <>
                <div
                  role="separator"
                  aria-orientation="horizontal"
                  aria-label="Resize console"
                  onPointerDown={startResize}
                  className="group relative z-10 h-px shrink-0 cursor-row-resize"
                >
                  {/* The visible border: 1px, three times thicker while hovered or dragged. */}
                  <div className="absolute inset-x-0 bottom-0 h-px bg-console-border transition-[height] duration-150 group-hover:h-[3px] group-active:h-[3px]" />
                  {/* Transparent, taller hit area so the border is easy to grab. */}
                  <div className="absolute inset-x-0 -top-2 -bottom-2 cursor-row-resize" />
                </div>
                <div style={{ height: `${consoleHeight * 100}%` }} className="min-h-0 shrink-0">
                  {preview ? (
                    <MarkdownPreview path={preview} source={previewText} onClose={() => setPreview(null)} />
                  ) : (
                    <ConsolePanel
                      status={consoleView.status}
                      chunks={sharedConsole.chunks}
                      exit={consoleView.exit}
                      canInput={canWrite}
                      draft={sharedConsole.draft}
                      onDraft={(value) => canWrite && setDraft(doc, value)}
                      timeoutSec={RUN_TIMEOUT_SEC}
                      onInput={sendInput}
                      onEof={sendEof}
                      onStop={stop}
                      onClear={() => {
                        const term = sharedTerminal(doc)
                        if (canWrite) term.delete(0, term.length)
                      }}
                      onClose={() => setConsoleOpen(false)}
                    />
                  )}
                </div>
              </>
            )}
          </main>
        </div>

        <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-console-border bg-console px-4 font-mono text-[11px] text-console-muted">
          <span className={cn("inline-flex items-center gap-1.5", errors > 0 && "text-[#ff6166]")}>
            <span className={cn("size-1.5 rounded-full", errors > 0 ? "bg-[#ff6166]" : "bg-[#62c073]")} />
            {errors === 0 ? t("footer.noErrors") : errors === 1 ? t("footer.error") : t("footer.errors", { n: errors })}
          </span>
          {!consoleOpen && (sharedConsole.chunks.length > 0 || runner.runCount > 0) && (
            <button onClick={() => setConsoleOpen(true)} className="inline-flex items-center gap-1 hover:text-console-foreground">
              <TerminalSquare className="size-3" /> {t("footer.console")}
            </button>
          )}
          {isGuest && <span className="text-[#52a8ff]">{t("footer.guest")}</span>}
          <span className="ml-auto hidden sm:inline">
            {t("footer.position", { line: cursor.line, col: cursor.column })}
          </span>
          <span className="hidden sm:inline">{LANGUAGE_LABEL[language]}</span>
          <span className="hidden md:inline">
            {runner.python ? t("footer.python", { v: runner.python }) : runner.booting ? t("footer.loadingPython") : t("footer.pythonIdle")}
          </span>
          {ruff && <span className="hidden lg:inline">Ruff {ruff}</span>}
          <button
            onClick={() => setLang(lang === "ru" ? "en" : "ru")}
            title={t("lang.label")}
            className="rounded border border-console-border px-1.5 uppercase hover:text-console-foreground"
          >
            {lang === "ru" ? "RU" : "EN"}
          </button>
        </footer>
      </div>

      <AstDialog open={treeOpen} onOpenChange={setTreeOpen} code={text} theme={THEME} onReveal={reveal} />
      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        available={collab.available}
        provider={provider}
        peers={collab.peers}
        onStart={collab.start}
        onJoin={collab.join}
        onLeave={collab.leave}
        onEnd={collab.end}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <RemoteCursorStyles peers={collab.peers} />
      <Toaster position="bottom-right" theme={THEME} />
    </TooltipProvider>
  )
}

const LANGUAGE_LABEL = { python: "Python", json: "JSON", yaml: "YAML", markdown: "Markdown", plaintext: "Plain text" } as const

function Breadcrumb({ path }: { path: string }) {
  const parts = path.split("/")
  return (
    <>
      {parts.slice(0, -1).map((p, i) => (
        <span key={i} className="text-muted-foreground">
          {p}
          <span className="px-1 text-muted-foreground/50">/</span>
        </span>
      ))}
      <span>{parts.at(-1)}</span>
    </>
  )
}

function ShareButton({
  live,
  peers,
  readOnly,
  onClick,
}: {
  live: boolean
  peers: { clientId: number; user: { color: string; name: string } }[]
  readOnly: boolean
  onClick: () => void
}) {
  if (!live) {
    return (
      <Button variant="ghost" size="sm" onClick={onClick} className="text-muted-foreground">
        <Radio /> <span className="hidden sm:inline">{translate("btn.share")}</span>
      </Button>
    )
  }
  const shown = peers.slice(0, 4)
  return (
    <Button variant="outline" size="sm" onClick={onClick} className="gap-2" aria-label="Live session">
      <span className="flex -space-x-1.5">
        {shown.map((p) => (
          <span
            key={p.clientId}
            title={p.user.name}
            className="size-4 rounded-full border-2 border-background"
            style={{ background: p.user.color }}
          />
        ))}
      </span>
      <span className="font-mono text-xs">{peers.length > 4 ? `+${peers.length - 4}` : peers.length}</span>
      <span className="hidden text-xs sm:inline">{readOnly ? translate("btn.liveReadOnly") : translate("btn.live")}</span>
    </Button>
  )
}

