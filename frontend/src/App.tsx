import { Bug, Code2, Columns2, Eye, FlaskConical, FolderTree, Moon, Presentation as PresentationIcon, Snowflake, Tag, Network, PanelBottom, Paintbrush, Play, Radio, Square, Sun } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"
import { toast } from "sonner"

import { AstDialog } from "@/components/ast-dialog"
import { CodeEditor, type EditorInstance } from "@/components/code-editor"
import { ConfirmDialog, type ConfirmRequest } from "@/components/confirm-dialog"
import { ConsolePanel } from "@/components/console-panel"
import { FileTree } from "@/components/file-tree"
import { LowerPanels } from "@/components/lower-panels"
import { MarkdownPreview } from "@/components/markdown-preview"
import { CppPackagesPanel } from "@/components/cpp-packages-panel"
import { PackagesPanel } from "@/components/packages-panel"
import { DocViewer } from "@/components/doc-viewer"
import { docKindOf } from "@/lib/project/project"
import { CheckResults, type CheckState } from "@/components/check-results"
import { DebugPanel } from "@/components/debug-panel"
import { FileViewer } from "@/components/file-viewer"
import { LivePagePreview, WebPreview, type WebRun } from "@/components/web-preview"
import { Presentation, type PresentationState } from "@/components/presentation"
import { FollowButton } from "@/components/follow-button"
import { FrostOverlay } from "@/components/frost-overlay"
import { LanguageDialog } from "@/components/language-dialog"
import { NameDialog } from "@/components/name-dialog"
import { TournamentPanel } from "@/components/tournament-panel"
import { RemoteCursorStyles } from "@/components/remote-cursors"
import { ShareDialog } from "@/components/share-dialog"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Toaster } from "@/components/ui/sonner"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useCollab } from "@/hooks/use-collab"
import { useTournaments } from "@/hooks/use-tournaments"
import { useCppPackages } from "@/hooks/use-cpp-packages"
import { usePackages } from "@/hooks/use-packages"
import { isBusy, RUN_TIMEOUT_SEC, useRunner, type ExitInfo, type RunEvent, type RunStatus } from "@/hooks/use-runner"
import { useAccess } from "@/hooks/use-access"
import { useFileDrop } from "@/hooks/use-file-drop"
import { useFollow } from "@/hooks/use-follow"
import { usePersisted } from "@/hooks/use-persisted"
import { DEFAULT_LAYOUT, activate, normalizeLayout, panelHeight, type Tool } from "@/lib/lower-layout"
import { useSharedConsole } from "@/hooks/use-shared-console"
import { toEditorColumn, type AstLoc } from "@/lib/ast"
import { appendTerminal, readRun, resetRun, setDraft, setRunStatus, sharedRun, sharedTerminal } from "@/lib/collab/doc"
import {
  addFiles,
  createDir,
  createFile,
  DEFAULT_FILE,
  deletePath,
  downloadBlob,
  exportZip,
  importZip,
  languageOf,
  languagesOf,
  localStore,
  metasOf,
  needsLanguage,
  packagesKind,
  packagesOf,
  duplicatePath,
  renamePath,
  resetProject,
  openArchive,
  PROJECT_LIMIT,
  projectFiles,
  rulesOf,
  startProject,
  STARTERS,
  stateOf,
  isCpp,
  testPathOf,
  ensureTournament,
  tournamentsOf,
  textOf,
  type ProjectLanguage,
} from "@/lib/project/project"
import { setLang, translate, useI18n } from "@/lib/i18n"
import { cppClient, useCppStatus } from "@/lib/cpp/client"
import { cppCompleter } from "@/lib/cpp/completer"
import { cppPackagesOf, loadCppPackages } from "@/lib/cpp/packages"
import { nameFor } from "@/lib/collab/identity"
import { whenClientKnown } from "@/lib/collab/known-client"
import { fileAccess, type Member } from "@/lib/project/access"
import { maxPoints, recordCheck, tableName } from "@/lib/tournament"
import { RunnerClient } from "@/lib/python/runner-client"
import { formatWith } from "@/lib/prettier"
import { serial } from "@/lib/queue"
import { buildPage, scriptPage } from "@/lib/web-preview"
import type { CheckOutcome, DebugCommand } from "@/workers/protocol"
import { format, lint, ruffVersion, type Diagnostic } from "@/lib/ruff"
import { runTool, type AgentApp } from "@/lib/agent/tools"
import { callTool } from "@/lib/python/tools-client"
import { memberLabel } from "@/lib/roles"
import { cn } from "@/lib/utils"

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform)
const MOD = IS_MAC ? "⌘" : "Ctrl"
const THEME_KEY = "polycode:theme"
const LABELS_KEY = "polycode:cursor-labels"

const MD_MODE_KEY = "polycode:md-mode"
const HTML_MODE_KEY = "polycode:html-mode"
const BREAKPOINTS_KEY = "polycode:breakpoints"
const LOWER_LAYOUT_KEY = "polycode:lower-layout"
const CHECK_COOLDOWN_MS = 3000
const FORMATTABLE = new Set(["python", "json", "html", "css", "javascript", "markdown"])
type ViewMode = "code" | "split" | "preview"

function loadTheme(): "dark" | "light" {
  try {
    return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"
  } catch {
    return "dark"
  }
}

function applyTheme(theme: "dark" | "light") {
  document.documentElement.classList.toggle("dark", theme === "dark")
  document.documentElement.style.colorScheme = theme
}

type View = "editor" | "board" | "packages"

// The whiteboard is big: loaded the first time its tab opens.
const Board = lazy(() => import("@/components/board"))

/** Waits for the local project (IndexedDB) before showing the workspace. */
export default function App() {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    applyTheme(loadTheme())
    localStore().ready.then(() => setReady(true))
  }, [])
  if (!ready) return <div className="h-full bg-background" />
  return <Workspace />
}

function Workspace() {
  const { lang, t } = useI18n()
  const [theme, setTheme] = useState(loadTheme)
  useEffect(() => {
    applyTheme(theme)
    try {
      localStorage.setItem(THEME_KEY, theme)
    } catch {
      // storage unavailable
    }
  }, [theme])
  const [labels, setLabels] = usePersisted(LABELS_KEY, false)
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [consoleOpen, setConsoleOpen] = useState(false)
  const [consoleHeight, setConsoleHeight] = useState(0.38)
  const [treeOpen, setTreeOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(true)
  const [filesWidth, setFilesWidth] = useState(() => {
    try {
      return Number(localStorage.getItem("polycode:files-width")) || 240
    } catch {
      return 240
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem("polycode:files-width", String(filesWidth))
    } catch {
      // storage unavailable
    }
  }, [filesWidth])
  const [view, setView] = useState<View>("editor")
  const [ruff, setRuff] = useState<string | null>(null)
  const [shareOpen, setShareOpen] = useState(false)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const [text, setText] = useState("")
  const editor = useRef<EditorInstance | null>(null)
  const [editorInstance, setEditorInstance] = useState<EditorInstance | null>(null)
  const split = useRef<HTMLDivElement>(null)

  // ---- project & session ------------------------------------------------------
  const collab = useCollab()
  const provider = collab.provider
  const store = provider?.store ?? localStore()
  const doc = store.runtime // console and run state
  const awareness = provider?.awareness ?? null
  const isGuest = !!provider && provider.store !== localStore()
  useEffect(() => {
    // End-to-end tests read the project through this hook (opt-in per browser).
    try {
      if (localStorage.getItem("polycode:e2e")) Object.assign(window, { __polycode: { store, provider } })
    } catch {
      // storage unavailable
    }
  }, [store, provider])

  const access = useAccess(store, provider, collab.version)
  // The project's languages decide which runtimes load; an empty new project asks for one.
  // Nothing loads until the project is there and has a language (a guest waits for the owner's).
  const [languages, setLanguages] = useState<ProjectLanguage[]>([])
  const [askLanguage, setAskLanguage] = useState(false)
  useEffect(() => {
    let ready = false
    const read = () => {
      const next = ready && !needsLanguage(store) ? languagesOf(store) : []
      setLanguages((prev) => (prev.join() === next.join() ? prev : next))
      setAskLanguage(ready && needsLanguage(store))
    }
    read()
    store.structure.on("update", read)
    void store.ready.then(() => {
      ready = true
      read()
    })
    return () => store.structure.off("update", read)
  }, [store])
  const hasPython = languages.includes("python")
  const [allFiles, setAllFiles] = useState<string[]>(() => [...metasOf(store).keys()])
  useEffect(() => {
    const map = metasOf(store)
    const read = () => setAllFiles([...map.keys()].sort())
    read()
    map.observe(read)
    return () => map.unobserve(read)
  }, [store])
  // Files we may not see are not there for us at all.
  const files = useMemo(() => allFiles.filter((p) => access.can(p) !== "none"), [allFiles, access])

  const [active, setActive] = useState(DEFAULT_FILE)
  // Keep the open file valid (deleted, or another project after joining/leaving).
  useEffect(() => {
    if (files.length && !files.includes(active)) setActive(files.includes(DEFAULT_FILE) ? DEFAULT_FILE : files[0])
  }, [files, active])
  const activeExists = files.includes(active)
  const packagesTab = packagesKind(active)
  const hasPackages = packagesTab !== null
  useEffect(() => {
    if (view === "packages" && !hasPackages) setView("editor")
  }, [view, hasPackages])
  const activeMeta = activeExists ? metasOf(store).get(active) : undefined
  const canWrite = activeExists && activeMeta?.kind === "text" && access.can(active) === "write"
  const docKind = activeMeta?.kind === "binary" ? docKindOf(active) : null
  const [docPos, setDocPos] = useState({ path: "", page: 1 })
  const docPage = docPos.path === active ? docPos.page : 1
  const fetchBlob = useMemo(() => (provider ? (hash: string) => provider.fetchBlob(hash) : undefined), [provider])
  const canRun = access.canRun
  const language = languageOf(active)
  // Markdown and HTML: the code, the result, or both side by side (each remembers its own).
  const [mdMode, setMdMode] = usePersisted<ViewMode>(MD_MODE_KEY, "split")
  const [htmlMode, setHtmlMode] = usePersisted<ViewMode>(HTML_MODE_KEY, "split")
  const viewMode = !activeExists ? null : language === "markdown" ? mdMode : language === "html" ? htmlMode : null
  const setViewMode = language === "html" ? setHtmlMode : setMdMode
  // Clang checks the open C++ file against the files a run would see.
  const cppStatus = useCppStatus()
  const cppPkgs = useCppPackages(useMemo(() => cppPackagesOf(store), [store]))
  const cppPackages = cppPkgs.packages
  const lintCpp = useCallback(
    async (source: string) => {
      const files = await projectFiles(store, provider, active)
      files[active] = source
      const pkgs = await loadCppPackages(cppPackages, cppPkgs.fail)
      // Only someone who can type here needs suggestions.
      if (canWrite) cppCompleter.prepare(files, active, source, pkgs)
      return cppClient.lint(files, active, pkgs)
    },
    [store, provider, active, cppPackages, cppPkgs.fail, canWrite],
  )
  const completeCpp = useCallback(
    async (source: string, line: number, column: number) => {
      const files = await projectFiles(store, provider, active)
      return cppCompleter.complete(files, active, source, line, column, await loadCppPackages(cppPackages, cppPkgs.fail))
    },
    [store, provider, active, cppPackages, cppPkgs.fail],
  )
  const follow = useFollow({
    provider,
    editor: editorInstance,
    tab: view,
    file: active,
    files,
    setTab: (tab) => setView(tab as View),
    setFile: setActive,
  })

  useEffect(() => {
    if (hasPython) ruffVersion().then(setRuff).catch(() => {})
  }, [hasPython])

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
    else if (event.type === "debug") sharedRun(d).set("debug", event.state)
  }, [])

  const runner = useRunner({ onRateLimited: (message) => toast.warning(message, { id: "rate-limited" }), onEvent: mirrorRun, warm: hasPython })
  const runnerRef = useRef(runner)
  useEffect(() => {
    runnerRef.current = runner
  })
  const packagesArray = useMemo(() => packagesOf(store), [store])
  const pkgs = usePackages(packagesArray)
  const shownPackages = packagesTab === "cpp" ? cppPackages : pkgs.packages

  // Input and Stop from other members reach us when we are the one running.
  useEffect(() => {
    if (!provider) return
    return provider.on("signal", (signal) => {
      if (readRun(provider.store.runtime).executorClient !== provider.clientID) return
      if (signal.type === "stdin") runnerRef.current.sendInput(signal.text)
      else if (signal.type === "eof") runnerRef.current.sendEof()
      else if (signal.type === "stop") runnerRef.current.stop()
    })
  }, [provider])

  // Everyone sees the console as soon as someone runs the program.
  const sharedStatus = sharedConsole.status
  useEffect(() => {
    if (sharedStatus !== "idle" && sharedStatus !== "finished") {
      setConsoleOpen(true)
    }
  }, [sharedStatus])

  const executorClient = sharedConsole.executorClient
  const amExecutor = executorClient === null || executorClient === doc.clientID
  const consoleView: { status: RunStatus; exit: ExitInfo | null } = sharedConsole.executorGone
    ? { status: "finished", exit: { code: null, duration: 0, reason: "error", message: t("console.executorLeft") } }
    : { status: sharedConsole.status, exit: sharedConsole.exit }
  const consoleActive = isBusy(consoleView.status)

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

  // Programs run in the console (C++ headers are not programs); web files in a frame.
  const consoleProgram = language === "python" || (language === "cpp" && !/\.(h|hpp)$/i.test(active))
  const runnable = consoleProgram || language === "html" || language === "javascript"

  // ---- debugger -------------------------------------------------------------------
  // Breakpoints are this browser's own (not shared): path -> lines.
  const [breakpoints, setBreakpoints] = usePersisted<Record<string, number[]>>(BREAKPOINTS_KEY, {})
  const toggleBreakpoint = useCallback(
    (line: number) =>
      setBreakpoints((all) => {
        const lines = all[active] ?? []
        return { ...all, [active]: lines.includes(line) ? lines.filter((l) => l !== line) : [...lines, line].sort((a, b) => a - b) }
      }),
    [active, setBreakpoints],
  )
  const debugCommand = useCallback(
    (command: DebugCommand) => {
      if (command === "stop") stop()
      else runner.debug(command)
    },
    [stop, runner],
  )
  // The one debugging follows the program into other files.
  const pausedAt = sharedConsole.debug
  useEffect(() => {
    if (pausedAt && amExecutor && pausedAt.file !== active && files.includes(pausedAt.file)) setActive(pausedAt.file)
  }, [pausedAt, amExecutor, active, files])
  // F5 / F10 / F11 / Shift+F11 while stopped.
  useEffect(() => {
    if (!pausedAt || !amExecutor) return
    const onKey = (e: KeyboardEvent) => {
      const command: DebugCommand | null =
        e.key === "F5" ? "continue" : e.key === "F10" ? "next" : e.key === "F11" ? (e.shiftKey ? "return" : "step") : null
      if (!command) return
      e.preventDefault()
      debugCommand(command)
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [pausedAt, amExecutor, debugCommand])

  // Web pages and scripts run in a sandboxed frame (see components/web-preview.tsx).
  const [webRun, setWebRun] = useState<WebRun | null>(null)
  const [savedLayout, setSavedLayout] = usePersisted<unknown>(LOWER_LAYOUT_KEY, DEFAULT_LAYOUT)
  const lowerLayout = useMemo(() => normalizeLayout(savedLayout), [savedLayout])
  const setLowerTab = useCallback((tool: Tool) => setSavedLayout((saved: unknown) => activate(normalizeLayout(saved), tool)), [setSavedLayout])
  const webStarted = useRef(0)
  const lastEntry = useRef<string | null>(null)
  const startRun = useCallback((debug: boolean) => {
    if (!activeExists) return
    setView("editor")
    if (!runnable) {
      toast.message(t("toast.onlyPython"))
      return
    }
    if (!canRun) return
    if (consoleProgram && !runner.allowRun()) return
    setConsoleOpen(true)
    // We become the one running the project's program; a run going on
    // elsewhere is stopped (its owner stops mirroring when we take over).
    const prev = readRun(doc)
    const busy = isBusy(prev.status)
    if (provider && busy && prev.executorClient !== null && prev.executorClient !== doc.clientID) {
      provider.signal({ type: "stop", to: prev.executorClient })
    }
    resetRun(doc, collab.me ?? "local")
    sharedRun(doc).set("debugging", debug && language === "python")
    if (language === "python") {
      setWebRun(null)
      if (debug) setLowerTab("debug")
      // Breakpoints of the project's files (an empty set still pauses on line 1).
      const points = debug ? Object.fromEntries(Object.entries(breakpoints).filter(([p]) => allFiles.includes(p))) : undefined
      // In a session, another file may be someone else's program: it gets its own interpreter.
      const fresh = !!provider && lastEntry.current !== null && lastEntry.current !== active
      lastEntry.current = active
      void runner.run(projectFiles(store, provider, active), active, pkgs.activeSpecs, points, fresh)
      return
    }
    if (language === "cpp") {
      setWebRun(null)
      setRunStatus(doc, "compiling") // resetRun's `connecting` means Python to the console
      void runner.runCpp(projectFiles(store, provider, active), active, async (files) =>
        cppClient.compile(files, active, await loadCppPackages(cppPackages, cppPkgs.fail)),
      )
      return
    }
    // A web page or script runs here, in a sandboxed frame; its console is shared like Python's.
    const token = crypto.randomUUID()
    setRunStatus(doc, "running")
    webStarted.current = performance.now()
    void projectFiles(store, provider, active).then((files) => {
      const page = language === "html" ? buildPage(files, active, token) : scriptPage(String(files[active] ?? ""), token)
      setWebRun({ path: active, page, token, visible: language === "html" })
      setLowerTab(language === "html" ? "web" : "console")
    })
  }, [activeExists, language, runnable, consoleProgram, active, canRun, doc, store, provider, collab.me, runner, pkgs.activeSpecs, t, breakpoints, allFiles, cppPackages, cppPkgs.fail])
  const run = useCallback(() => startRun(false), [startRun])
  const debugRun = useCallback(() => startRun(true), [startRun])

  const webOutput = useCallback(
    (kind: "stdout" | "stderr", text: string) => {
      if (readRun(doc).executorClient === doc.clientID) appendTerminal(doc, kind, text)
    },
    [doc],
  )
  const webLoaded = useCallback(() => {
    if (readRun(doc).executorClient !== doc.clientID) return
    setRunStatus(doc, "finished", { code: 0, duration: (performance.now() - webStarted.current) / 1000, reason: null })
  }, [doc])
  // ---- automatic checks: name.py against name.test.py, run in an admin's browser ----
  const [check, setCheck] = useState<CheckState | null>(null)
  const hasTest = testPathOf(active, allFiles) !== null
  const canCheck = !provider || provider.isAdmin || provider.adminOnline

  /** Runs the tests of `path` here (we are an admin, or alone). */
  const checkHere = useCallback(
    async (path: string): Promise<Pick<CheckState, "results" | "error" | "tournament"> & { testFile?: string }> => {
      const testFile = testPathOf(path, Object.keys(rulesOf(store).files))
      const test = testFile === null ? undefined : textOf(store, testFile)?.toString()
      if (test === undefined) return { results: null, error: t("check.noTests") }
      const finished = ({ results, tournament }: CheckOutcome) => {
        return { results, testFile: testFile!, tournament: tournament && { ...tournament, max: maxPoints(results) } }
      }
      try {
        const files = await projectFiles(store, provider, path)
        if (!isCpp(path)) return finished(await new RunnerClient().check(files, path, test, pkgs.activeSpecs))
        const { wasm, log } = await cppClient.compile(files, path, await loadCppPackages(cppPackages, cppPkgs.fail))
        if (!wasm) return { results: null, error: t("check.compileFailed", { log: log.split("\n").slice(0, 5).join("\n") }) }
        return finished(await new RunnerClient().check(files, path, test, pkgs.activeSpecs, wasm))
      } catch (err) {
        const message = (err as Error).message
        return { results: null, error: message === "timeout" ? t("check.timeout") : t("check.failed", { error: message }) }
      }
    },
    [store, provider, pkgs.activeSpecs, t, cppPackages, cppPkgs.fail],
  )

  /** Puts a finished check into its tournament's table; true if it was refused. */
  const recordIn = useCallback(
    (path: string, done: Awaited<ReturnType<typeof checkHere>>, who: { userId: string; name: string }, member: Member | null) => {
      if (!done.tournament || !done.results || !done.testFile) return false
      if (!tournamentsOf(store).has(done.tournament.id)) return true // the test file's author may not declare tables
      return recordCheck(store.doc(`t:${done.tournament.id}`), done.results, path, done.testFile, who, member, rulesOf(store), Date.now())
    },
    [store],
  )

  const startCheck = useCallback(async () => {
    if (!hasTest || !canRun) return
    setConsoleOpen(true)
    setLowerTab("tests")
    setCheck({ path: active, results: null })
    const to = provider?.checker()
    if (provider && to !== provider.clientID) {
      if (to === null || to === undefined) setCheck({ path: active, results: null, error: t("check.noTeacher") })
      else provider.signal({ type: "check", to, from: provider.clientID, path: active })
      return
    }
    const done = await checkHere(active)
    if (done.tournament) ensureTournament(store, done.tournament.id, done.tournament.private)
    // In a session an admin's own check is only a try: the table is for students' runs.
    const userId = collab.me ?? "local"
    const unrecorded = provider ? false : recordIn(active, done, { userId, name: nameFor(userId) }, null)
    setCheck({ path: active, ...done, unrecorded })
  }, [hasTest, canRun, active, provider, checkHere, t, collab.me, recordIn])

  const checks = useRef(serial())
  const lastCheck = useRef(new Map<number, number>())
  // Students' requests reach the admin chosen to check; the result goes back to them only.
  useEffect(() => {
    if (!provider) return
    return provider.on("signal", (signal, from) => {
      // Results count only from an admin; requests answer only their real sender.
      if (signal.type === "check-result" && from.level !== "admin") return
      if (signal.type === "check-result") {
        setCheck({ path: signal.path, results: signal.results, error: signal.error, tournament: signal.tournament, unrecorded: signal.unrecorded })
        setConsoleOpen(true)
        setLowerTab("tests")
        return
      }
      if (signal.type !== "check" || !provider.isAdmin) return
      whenClientKnown(from.clients, signal.from, () => {
        // Only for a real file (not another spelling of its path) the student may see.
        const rules = rulesOf(store)
        if (!Object.hasOwn(rules.files, signal.path) || fileAccess(from, signal.path, rules) === "none") return
        // Each check starts a whole Python: one at a time, and at most one per student every few seconds.
        const now = Date.now()
        if (now - (lastCheck.current.get(signal.from) ?? 0) < CHECK_COOLDOWN_MS) {
          provider.signal({ type: "check-result", to: signal.from, path: signal.path, results: [], error: t("check.tooSoon") })
          return
        }
        lastCheck.current.set(signal.from, now)
        void checks
          .current(() => checkHere(signal.path))
          .then((r) => {
            // After the check: the student's role may have changed while it waited its turn.
            const member = provider.memberOf(signal.from) ?? from
            const name = tableName((provider.awareness.getStates().get(signal.from)?.user as { name?: unknown } | undefined)?.name, nameFor(from.userId))
            // A test file a student can change must not create tables or change who sees them.
            if (r.tournament && r.testFile && fileAccess(member, r.testFile, rulesOf(store)) !== "write") ensureTournament(store, r.tournament.id, r.tournament.private)
            const unrecorded = recordIn(signal.path, r, { userId: from.userId, name }, member)
            provider.signal({ type: "check-result", to: signal.from, path: signal.path, results: r.results ?? [], error: r.error, tournament: r.tournament, unrecorded })
          })
      })
    })
  }, [provider, store, checkHere, t, recordIn])

  const tournaments = useTournaments(store, access)
  // A program asks for input: whoever can type is taken to the console, and a debugger's next stop brings them back.
  const backToDebug = useRef(false)
  const waitingForInput = consoleView.status === "waiting" && canRun
  useEffect(() => {
    if (!waitingForInput) return
    setConsoleOpen(true)
    backToDebug.current = sharedConsole.debugging
    setLowerTab("console")
  }, [waitingForInput, setLowerTab])
  const debugState = sharedConsole.debug
  useEffect(() => {
    if (!debugState || !backToDebug.current) return
    backToDebug.current = false
    setLowerTab("debug")
  }, [debugState, setLowerTab])

  // A tool is gone (the table after a Reset, the debugger after its run): its group shows another.
  const lowerTools: { id: Tool; label: string }[] = [
    ...(webRun?.visible ? [{ id: "web" as const, label: t("web.preview") }] : []),
    ...(check ? [{ id: "tests" as const, label: t("check.tab") }] : []),
    ...(tournaments.length ? [{ id: "tournament" as const, label: t("tournament.tab") }] : []),
    ...(sharedConsole.debugging ? [{ id: "debug" as const, label: t("debug.tab") }] : []),
    { id: "console" as const, label: t("console.title") },
  ]
  const webPanel = (tabs: ReactNode) =>
    webRun && <WebPreview run={webRun} tabs={tabs} onOutput={webOutput} onLoad={webLoaded} onReload={() => run()} onClose={() => setConsoleOpen(false)} />

  // ---- an agent (MCP): its tools run here, on this tab's runners and screen ----------
  const agentLatest = useRef({ active, activeExists, startRun, sendInput, sendEof, stop, debugCommand, checkHere, pkgs, cppPkgs, cppPackages })
  useEffect(() => {
    agentLatest.current = { active, activeExists, startRun, sendInput, sendEof, stop, debugCommand, checkHere, pkgs, cppPkgs, cppPackages }
  })
  const agentApp = useMemo<AgentApp>(() => {
    const show = (path: string) => {
      setActive(path)
      setView("editor")
    }
    return {
      active: () => agentLatest.current.active,
      open: show,
      moved: (map) => setActive((current) => map(current)),
      async run(path, debug, points) {
        if (points) setBreakpoints((all) => ({ ...all, ...points }))
        show(path)
        // startRun runs what is open: wait for the render that opens it.
        for (let tries = 0; tries < 100 && !(agentLatest.current.active === path && agentLatest.current.activeExists); tries++) await new Promise((r) => setTimeout(r, 20))
        // Breakpoints reach startRun through a render too.
        await new Promise((r) => setTimeout(r, 40))
        agentLatest.current.startRun(debug)
      },
      sendInput: (text) => agentLatest.current.sendInput(text),
      sendEof: () => agentLatest.current.sendEof(),
      stop: () => agentLatest.current.stop(),
      debugCommand: (command) => agentLatest.current.debugCommand(command),
      async check(path) {
        setCheck({ path, results: null })
        setConsoleOpen(true)
        setLowerTab("tests")
        const done = await agentLatest.current.checkHere(path)
        // In a session an admin's own check is only a try: the table is for students' runs.
        if (done.tournament) ensureTournament(store, done.tournament.id, done.tournament.private)
        setCheck({ path, ...done })
        return done
      },
      installPython: (spec) => agentLatest.current.pkgs.add(spec),
      removePython: (name) => agentLatest.current.pkgs.remove(name),
      installCpp: (spec) => agentLatest.current.cppPkgs.add(spec),
      removeCpp: (repo) => agentLatest.current.cppPkgs.remove(repo),
      async diagnostics(path) {
        const source = textOf(store, path)?.toString() ?? ""
        if (languageOf(path) === "python") return lint(source)
        if (languageOf(path) !== "cpp") return []
        const files = await projectFiles(store, provider, path)
        return cppClient.lint(files, path, await loadCppPackages(agentLatest.current.cppPackages, agentLatest.current.cppPkgs.fail))
      },
      async format(path, code) {
        const language = languageOf(path)
        if (language === "json") return JSON.stringify(JSON.parse(code), null, 2) + "\n"
        if (language === "python") return format(code)
        if (language === "html" || language === "css" || language === "javascript" || language === "markdown") return formatWith(language, code)
        throw new Error(`${path} has no formatter`)
      },
      async analyse(path, code, mode, lang) {
        const language = languageOf(path)
        if (language === "cpp") return mode === "flow" ? (await import("@/lib/cpp/flow")).cppFlow(code, lang as never) : (await import("@/lib/cpp/tree")).cppTree(code)
        if (language !== "python") throw new Error("only Python and C++ can be analysed")
        return callTool(mode, { code, lang: lang as never })
      },
    }
  }, [store, provider, setBreakpoints, setLowerTab])
  const [agentTool, setAgentTool] = useState<string | null>(null)
  useEffect(() => {
    if (!provider) return
    let running = 0
    return provider.on("mcp", (id, name, args) => {
      running++
      setAgentTool(name)
      void runTool(name, args, { store, provider, app: agentApp }).then((result) => {
        provider.mcpResult(id, result)
        if (--running === 0) setAgentTool(null)
      })
    })
  }, [provider, store, agentApp])

  // ---- project actions ----------------------------------------------------------
  const download = useCallback(async () => {
    const missing: string[] = []
    const zip = await exportZip(store, provider ? (hash) => provider.fetchBlob(hash) : undefined, missing)
    if (missing.length) toast.warning(t("toast.zipMissing", { files: missing.join(", ") }))
    downloadBlob(zip, provider ? `polycode-${provider.code}.zip` : "polycode-project.zip")
  }, [store, provider, t])

  const upload = useCallback(
    async (file: File) => {
      let content: ReturnType<typeof importZip>
      try {
        content = importZip(new Uint8Array(await file.arrayBuffer()))
      } catch {
        toast.error(t("toast.badZip"))
        return
      }
      if (content.size > PROJECT_LIMIT) {
        toast.error(t("toast.tooBig", { mb: PROJECT_LIMIT >> 20 }))
        return
      }
      const count = content.entries.length
      setConfirm({
        title: t("confirm.zip.title"),
        description: t("confirm.zip.text", { name: file.name, n: count, whose: t(provider ? "confirm.zip.whoseSession" : "confirm.zip.whoseYour") }),
        action: t("confirm.zip.action"),
        destructive: true,
        onConfirm: async () => {
          const opened = await openArchive(store, content)
          if ("error" in opened) {
            toast.error(t("toast.tooBig", { mb: PROJECT_LIMIT >> 20 }))
            return
          }
          const paths = content.entries.map((e) => e.path)
          const first = paths.sort((a, b) => Number(b.endsWith(".py")) - Number(a.endsWith(".py")) || a.localeCompare(b))[0]
          setActive(paths.includes(DEFAULT_FILE) ? DEFAULT_FILE : first ?? DEFAULT_FILE)
          toast.success(t("toast.opened", { name: file.name }))
        },
      })
    },
    [store, provider],
  )

  // A presentation shown to everyone (structure.state.presentation).
  const [presentation, setPresentation] = useState<PresentationState | null>(null)
  useEffect(() => {
    const state = stateOf(store)
    const read = () => setPresentation((state.get("presentation") as PresentationState | undefined) ?? null)
    read()
    state.observe(read)
    return () => state.unobserve(read)
  }, [store])
  const startPresentation = () => {
    stateOf(store).set("presentation", { path: active, page: docPage, by: store.clientID } satisfies PresentationState)
    document.documentElement.requestFullscreen?.().catch(() => {})
  }
  const stopPresentation = useCallback(() => {
    stateOf(store).delete("presentation")
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
  }, [store])

  // Files dropped onto the page from anywhere (admins: the tree is theirs to change).
  const [flash, setFlash] = useState<Set<string>>(new Set())
  const drop = useFileDrop(access.isAdmin, async (folder, dropped) => {
    const result = await addFiles(store, folder, dropped)
    if ("error" in result) {
      toast.error(t("toast.tooBig", { mb: PROJECT_LIMIT >> 20 }))
      return
    }
    setFlash(new Set(result.added))
    setTimeout(() => setFlash(new Set()), 1300)
    if (result.added.length === 1) {
      setActive(result.added[0])
      setView("editor")
    }
  })
  useEffect(() => {
    if (drop.dragging) setFilesOpen(true)
  }, [drop.dragging])

  // In a session only the owner resets — the session's project, for everyone.
  const canReset = !provider || provider.isOwner

  const reset = useCallback(() => {
    if (!canReset) return
    setConfirm({
      title: t("confirm.reset.title"),
      description: provider ? t("confirm.reset.session") : t("confirm.reset.own"),
      action: t("confirm.reset.action"),
      destructive: true,
      onConfirm: () => {
        resetProject(store)
        setActive(DEFAULT_FILE)
        provider?.announceReset()
        toast.success(t("toast.reset"))
      },
    })
  }, [canReset, provider, store, t])

  // A new project's language: only in our own store (a guest, even an admin standing in, waits for the owner's files).
  const chooseLanguage = useCallback(
    (lang: ProjectLanguage) => {
      if (!needsLanguage(store)) return
      startProject(store, lang)
      setActive(STARTERS[lang].path)
      setView("editor")
    },
    [store],
  )

  // Everyone else follows the owner's reset.
  useEffect(() => {
    if (!provider) return
    return provider.on("reset", () => {
      setActive(DEFAULT_FILE)
      toast.message(t("toast.ownerReset"))
    })
  }, [provider, t])

  const createEntry = useCallback(
    (path: string, kind: "file" | "dir") => {
      if (kind === "dir") createDir(store, path)
      else {
        createFile(store, path)
        setActive(path)
        setView("editor")
      }
    },
    [store],
  )

  const deleteEntry = useCallback((path: string) => deletePath(store, path), [store])

  const renameEntry = useCallback(
    (from: string, to: string) => {
      const map = renamePath(store, from, to)
      setActive((current) => map(current))
    },
    [store],
  )

  const duplicateEntry = useCallback(
    (path: string) => {
      if ("error" in duplicatePath(store, path)) toast.error(t("toast.tooBig", { mb: PROJECT_LIMIT >> 20 }))
    },
    [store, t],
  )

  const formatCode = useCallback(async () => {
    const ed = editor.current
    const model = ed?.getModel()
    if (!ed || !model) return
    try {
      const current = model.getValue()
      const formatted =
        language === "json"
          ? JSON.stringify(JSON.parse(current), null, 2) + "\n"
          : language === "python"
            ? await format(current)
            : await formatWith(language as "html" | "css" | "javascript" | "markdown", current)
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
    const before = consoleHeight
    const onMove = (ev: PointerEvent) => {
      const next = panelHeight((rect.bottom - ev.clientY) / rect.height)
      setConsoleOpen(next !== null)
      // Collapsed: opening it again brings back the height from before this drag.
      setConsoleHeight(next ?? before)
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
                  ["board", t("tab.board")],
                  ["packages", t("tab.packages")],
                ] as const
              )
                .filter(([value]) => value !== "packages" || hasPackages)
                .map(([value, label]) => (
                <button
                  key={value}
                  role="tab"
                  aria-selected={view === value}
                  onClick={() => {
                  follow.stop()
                  setView(value)
                }}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
                    view === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                  {value === "packages" && shownPackages.length > 0 && (
                    <span className="rounded-full bg-foreground/10 px-1.5 font-mono text-[10px]">{shownPackages.length}</span>
                  )}
                </button>
              ))}
            </nav>
            {viewMode && view === "editor" && (
              <nav role="radiogroup" aria-label={t("md.mode")} className="inline-flex shrink-0 rounded-md border border-border bg-muted p-0.5">
                {(
                  [
                    ["code", Code2, t("md.code")],
                    ["split", Columns2, t("md.split")],
                    ["preview", Eye, t("md.preview")],
                  ] as const
                ).map(([value, Icon, label]) => (
                  <button
                    key={value}
                    role="radio"
                    aria-checked={viewMode === value}
                    title={label}
                    aria-label={label}
                    onClick={() => setViewMode(value)}
                    className={cn(
                      "inline-flex items-center rounded-[5px] px-2 py-1 transition-colors [&_svg]:size-3.5",
                      viewMode === value ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    <Icon />
                  </button>
                ))}
              </nav>
            )}
          </div>

          <div className="ml-auto flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={formatCode}
                  disabled={!canWrite || !FORMATTABLE.has(language)}
                  className="hidden text-muted-foreground sm:inline-flex"
                >
                  <Paintbrush /> {t("btn.format")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{language === "json" ? t("btn.format.json") : language === "python" ? t("btn.format.ruff") : t("btn.format.prettier")}</TooltipContent>
            </Tooltip>
            <Button variant="outline" size="sm" onClick={() => setTreeOpen(true)} disabled={language !== "python" && language !== "cpp"}>
              <Network /> <span className="hidden sm:inline">{t("btn.tree")}</span>
            </Button>
            <span aria-hidden className="mx-1 h-5 w-px self-center bg-border" />
            {docKind && access.isAdmin && (
              <Button variant="outline" size="sm" onClick={() => startPresentation()}>
                <PresentationIcon /> <span className="hidden sm:inline">{t("present.start")}</span>
              </Button>
            )}
            {provider && access.isAdmin && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={access.frozen ? "secondary" : "ghost"}
                    size="icon-sm"
                    aria-pressed={access.frozen}
                    aria-label={t(access.frozen ? "freeze.off" : "freeze.on")}
                    onClick={() => stateOf(store).set("frozen", !access.frozen)}
                    className={cn(!access.frozen && "text-muted-foreground", access.frozen && "text-[#52a8ff]")}
                  >
                    <Snowflake />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t(access.frozen ? "freeze.off" : "freeze.on")}</TooltipContent>
              </Tooltip>
            )}
            {provider && (
              <FollowButton
                peers={collab.peers}
                leaderId={follow.leaderId}
                onFollowOwner={() => follow.setTarget(provider.isOwner ? (collab.peers.find((p) => !p.isMe)?.clientId ?? null) : "owner")}
                onFollow={(id) => follow.setTarget(id)}
                onStop={follow.stop}
              />
            )}
            <ShareButton live={!!provider} peers={collab.peers} role={provider ? memberLabel(provider.member) : undefined} onClick={() => setShareOpen(true)} />
            {hasTest && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <Button variant="outline" size="sm" onClick={() => void startCheck()} disabled={!canRun || !canCheck || (!!check && !check.results && !check.error)}>
                      <FlaskConical /> <span className="hidden sm:inline">{t("check.btn")}</span>
                    </Button>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{canCheck ? t("check.hint") : t("check.noTeacher")}</TooltipContent>
              </Tooltip>
            )}
            {language === "python" && !(consoleActive && canRun) && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" onClick={debugRun} disabled={!canRun || !activeExists}>
                    <Bug /> <span className="hidden sm:inline">{t("debug.btn")}</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{t("debug.hint")}</TooltipContent>
              </Tooltip>
            )}
            {consoleActive && canRun && consoleProgram ? (
              <Button size="sm" variant="secondary" onClick={stop} className="min-w-24">
                <Square className="fill-current" /> {t("btn.stop")}
              </Button>
            ) : (
              <Button size="sm" onClick={() => run()} disabled={!runnable || (consoleProgram && !canRun)} className="min-w-24">
                <Play className="fill-current" /> {t("btn.run")}
                <Kbd className="ml-1 hidden h-4 bg-primary-foreground/15 px-1 text-[10px] text-primary-foreground sm:inline-flex">{MOD}↵</Kbd>
              </Button>
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          {filesOpen && (
            <div style={{ width: filesWidth }} className="h-full min-w-0 shrink-0">
              <FileTree
                store={store}
                active={active}
                readOnly={!access.isAdmin}
                access={access}
                peers={collab.peers}
                drop={drop}
                flash={flash}
                onOpen={(path) => {
                  follow.stop()
                  setActive(path)
                  setView("editor")
                }}
                onCreate={createEntry}
                onDelete={deleteEntry}
              onRename={renameEntry}
              onDuplicate={duplicateEntry}
                onDownload={download}
                onUpload={upload}
                onReset={reset}
              canReset={canReset}
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

          {view === "board" && (
            <main className="min-h-0 min-w-0 flex-1">
              <Suspense fallback={<div className="size-full bg-background" />}>
                <Board store={store} awareness={awareness} readOnly={!canRun} theme={theme} labels={labels} leaderId={follow.leaderId} />
              </Suspense>
            </main>
          )}
          {view === "packages" && (
            <main className="min-h-0 min-w-0 flex-1">
              {packagesTab === "cpp" ? (
                <CppPackagesPanel packages={cppPackages} readOnly={!access.isAdmin} onAdd={cppPkgs.add} onRemove={cppPkgs.remove} onRetry={cppPkgs.retry} />
              ) : (
                <PackagesPanel packages={pkgs.packages} readOnly={!access.isAdmin} onAdd={pkgs.add} onRemove={pkgs.remove} onRetry={pkgs.retry} />
              )}
            </main>
          )}
          {/* The editor stays mounted (hidden) so its state survives tab switches. */}
          <main ref={split} className={cn("flex min-h-0 min-w-0 flex-1 flex-col", view !== "editor" && "hidden")}>
            <div className="flex min-h-0 flex-1">
            <div className={cn("relative min-h-0 min-w-0 flex-1", viewMode === "preview" && "hidden")}>
              <CodeEditor
                store={store}
                breakpoints={language === "python" ? (breakpoints[active] ?? []) : undefined}
                onToggleBreakpoint={language === "python" ? toggleBreakpoint : undefined}
                lintCpp={language === "cpp" ? lintCpp : undefined}
                completeCpp={language === "cpp" && canWrite ? completeCpp : undefined}
                debugLine={sharedConsole.debugging && consoleActive && sharedConsole.debug?.file === active ? sharedConsole.debug.line : null}
                path={active}
                available={activeExists}
                awareness={awareness}
                readOnly={!canWrite}
                theme={theme}
                onText={setText}
                onDiagnostics={setDiagnostics}
                onCursor={(line, column) => setCursor({ line, column })}
                onRun={run}
                onSave={download}
                onMount={(ed) => {
                  editor.current = ed
                  setEditorInstance(ed)
                }}
              />
              {activeExists && activeMeta?.kind === "binary" && (
                <div className="absolute inset-0">
                  <FileViewer
                    path={active}
                    meta={activeMeta}
                    fetch={fetchBlob}
                    render={
                      docKind
                        ? (bytes) => <DocViewer bytes={bytes} kind={docKind} page={docPage} onPage={(page) => setDocPos({ path: active, page })} />
                        : undefined
                    }
                  />
                </div>
              )}
              {!activeExists && (
                <div className="absolute inset-0 flex items-center justify-center bg-background text-sm text-muted-foreground">
                  {!isGuest ? t("editor.createFile") : files.length || provider?.adminOnline ? t("editor.waitingProject") : t("editor.waitingTeacher")}
                </div>
              )}
            </div>
            {viewMode && viewMode !== "code" && (
              <div className={cn("min-h-0 min-w-0 border-l border-console-border", viewMode === "split" ? "w-1/2" : "flex-1")}>
                {language === "html" ? (
                  <LivePagePreview path={active} source={text} files={() => projectFiles(store, provider, active)} />
                ) : (
                  <MarkdownPreview path={active} source={text} store={store} fetch={fetchBlob} />
                )}
              </div>
            )}
            </div>

            {/* Stays when the panel is collapsed: dragging it up brings the panel back. */}
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize panel"
              onPointerDown={startResize}
              className="group relative z-10 h-px shrink-0 cursor-row-resize"
            >
              {/* The visible border: 1px, three times thicker while hovered or dragged. */}
              <div className="absolute inset-x-0 bottom-0 h-px bg-console-border transition-[height] duration-150 group-hover:h-[3px] group-active:h-[3px]" />
              {/* Transparent, taller hit area so the border is easy to grab; collapsed, it stays off the footer. */}
              <div className={cn("absolute inset-x-0 -top-2 cursor-row-resize", consoleOpen ? "-bottom-2" : "bottom-0")} />
            </div>
            {consoleOpen && (
              <>
                <div style={{ height: `${consoleHeight * 100}%` }} className="min-h-0 shrink-0">
                  {/* A script (Run on .js) has no tab, but its frame must live. */}
                  {webRun && !webRun.visible && webPanel(undefined)}
                  <LowerPanels
                    layout={lowerLayout}
                    onLayout={setSavedLayout}
                    tools={lowerTools}
                    onActivate={setLowerTab}
                    render={(tool, tabs, visible) => {
                      if (tool === "web") return webRun && webPanel(tabs)
                      if (tool === "tests") return check && <CheckResults check={check} tabs={tabs} onClose={() => setConsoleOpen(false)} />
                      if (tool === "tournament") return <TournamentPanel tournaments={tournaments} tabs={tabs} onClose={() => setConsoleOpen(false)} />
                      if (tool === "debug") {
                        return (
                          <DebugPanel
                            state={consoleActive ? sharedConsole.debug : null}
                            canControl={amExecutor && consoleActive}
                            tabs={tabs}
                            onCommand={debugCommand}
                            onOpen={(file, line) => {
                              if (!files.includes(file)) return
                              setActive(file)
                              setTimeout(() => editor.current?.revealLineInCenter(line), 80)
                            }}
                            onClose={() => setConsoleOpen(false)}
                          />
                        )
                      }
                      return (
                        <ConsolePanel
                          tabs={tabs}
                          visible={visible}
                          status={consoleView.status}
                          chunks={sharedConsole.chunks}
                          exit={consoleView.exit}
                          canInput={canRun}
                          doc={doc}
                          onDraft={(value) => canRun && setDraft(doc, value)}
                          timeoutSec={RUN_TIMEOUT_SEC}
                          onInput={sendInput}
                          onEof={sendEof}
                          onStop={stop}
                          onClear={() => {
                            const term = sharedTerminal(doc)
                            if (canRun) term.delete(0, term.length)
                          }}
                          onClose={() => setConsoleOpen(false)}
                        />
                      )
                    }}
                  />
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
          <button onClick={() => setConsoleOpen((open) => !open)} aria-pressed={consoleOpen} className={cn("inline-flex items-center gap-1 hover:text-console-foreground", consoleOpen && "text-console-foreground")}>
            <PanelBottom className="size-3" /> {t("footer.panel")}
          </button>
          {isGuest && <span className="text-[#52a8ff]">{t("footer.guest")}</span>}
          {agentTool && <span className="truncate text-[#52a8ff]">{t("footer.agent", { tool: agentTool })}</span>}
          <span className="ml-auto hidden sm:inline">
            {t("footer.position", { line: cursor.line, col: cursor.column })}
          </span>
          <span className="hidden sm:inline">{LANGUAGE_LABEL[language]}</span>
          {hasPython && (
            <span className="hidden md:inline">
              {runner.python ? t("footer.python", { v: runner.python }) : runner.booting ? t("footer.loadingPython") : t("footer.pythonIdle")}
            </span>
          )}
          {(language === "cpp" || cppStatus !== "idle") && (
            <span className="hidden md:inline">{t(cppStatus === "loading" ? "footer.loadingCpp" : cppStatus === "failed" ? "footer.cppFailed" : "footer.cpp")}</span>
          )}
          {ruff && <span className="hidden lg:inline">Ruff {ruff}</span>}
          <button
            onClick={() => setLang(lang === "ru" ? "en" : "ru")}
            title={t("lang.label")}
            className="rounded border border-console-border px-1.5 uppercase hover:text-console-foreground"
          >
            {lang === "ru" ? "RU" : "EN"}
          </button>
          {provider && (
            <button
              onClick={() => setLabels((v) => !v)}
              title={t(labels ? "footer.labelsOn" : "footer.labelsOff")}
              aria-label={t(labels ? "footer.labelsOn" : "footer.labelsOff")}
              aria-pressed={labels}
              className={cn(
                "flex size-[18px] items-center justify-center rounded border border-console-border hover:text-console-foreground",
                labels && "bg-white/10 text-console-foreground",
              )}
            >
              <Tag className="size-3" />
            </button>
          )}
          <button
            onClick={() => setTheme((v) => (v === "dark" ? "light" : "dark"))}
            title={t(theme === "dark" ? "theme.light" : "theme.dark")}
            aria-label={t(theme === "dark" ? "theme.light" : "theme.dark")}
            className="flex size-[18px] items-center justify-center rounded border border-console-border hover:text-console-foreground"
          >
            {theme === "dark" ? <Sun className="size-3" /> : <Moon className="size-3" />}
          </button>
        </footer>
      </div>

      <AstDialog
        open={treeOpen}
        onOpenChange={setTreeOpen}
        code={text}
        theme={theme}
        onReveal={reveal}
        language={language === "cpp" ? "cpp" : "python"}
      />
      <ShareDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        available={collab.available}
        provider={provider}
        store={store}
        peers={collab.peers}
        onStart={collab.start}
        onJoin={collab.join}
        onLeave={collab.leave}
        onEnd={collab.end}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
      <RemoteCursorStyles peers={collab.peers} labels={labels} />
      {presentation && metasOf(store).has(presentation.path) && (
        <Presentation
          store={store}
          state={presentation}
          me={store.clientID}
          presenterName={collab.peers.find((p) => p.clientId === presentation.by)?.user.name ?? "…"}
          presenterHere={!provider || collab.peers.some((p) => p.clientId === presentation.by)}
          admin={access.isAdmin}
          fetch={fetchBlob}
          onPage={(page) => stateOf(store).set("presentation", { ...presentation, page })}
          onStop={stopPresentation}
        />
      )}
      <FrostOverlay frozen={!!provider && access.frozen} admin={access.isAdmin} />
      <LanguageDialog open={askLanguage && !isGuest} onChoose={chooseLanguage} />
      <NameDialog key={collab.nameAsk ? "ask" : "idle"} initial={collab.nameAsk?.initial ?? null} onSubmit={collab.nameAsk?.resolve ?? null} />
      <Toaster position="bottom-right" theme={theme} />
    </TooltipProvider>
  )
}

const LANGUAGE_LABEL = {
  python: "Python",
  json: "JSON",
  yaml: "YAML",
  markdown: "Markdown",
  html: "HTML",
  css: "CSS",
  javascript: "JavaScript",
  cpp: "C++",
  plaintext: "Plain text",
} as const

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
  role,
  onClick,
}: {
  live: boolean
  peers: { clientId: number; user: { color: string; name: string } }[]
  role?: string
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
      <span className="hidden text-xs sm:inline">{role ?? translate("btn.live")}</span>
    </Button>
  )
}

