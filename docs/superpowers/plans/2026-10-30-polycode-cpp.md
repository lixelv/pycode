# polycode: C++, лимиты тестов, переименование — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pycode → polycode. Добавить вкладку Packages по языку, лимиты и замеры в
`polycode_test.run`, `polycode_test.module`. Добавить C++: язык проекта,
подсветку, линтер, запуск, деревья, пакеты и проверку Python-тестами.

**Architecture:** Всё работает в браузере. Clang/LLD (`@yowasp/clang`)
работает в своём воркере (`cpp.worker.ts`): линтит и компилирует в
wasm32-wasi. Программа выполняется в `cpp-run.worker.ts` через
`@bjorn3/browser_wasi_shim`, протокол событий тот же, что у Python. Деревья
C++ строятся на странице через web-tree-sitter. Для проверки C++ Python-тесты
в воркере проверки синхронно запускают wasm во вложенном воркере.

**Tech Stack:** React 19, Vite, Monaco, Yjs, Pyodide, `@yowasp/clang`,
`@bjorn3/browser_wasi_shim`, `web-tree-sitter` + `tree-sitter-cpp`, Go 1.26,
Postgres.

**Spec:** `docs/superpowers/specs/2026-10-30-polycode-cpp-design.md`

## Global Constraints

- Ответы и обсуждение на русском. UI-строки на английском, русский в `i18n.ts`, обе локали.
- Коммит после каждой задачи. В конце сообщения строка `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Ветка `classroom`, не пушить и не мержить.
- После каждой задачи: `cd frontend && npx tsc -b && npx oxlint src && npx vitest run`. Для Go: `cd backend && gofmt -w . && go vet ./... && go test ./...`.
- Python-тесты: `/opt/homebrew/bin/python3.14 -m unittest discover -s frontend/src/python/tests`. Только `unittest`, без pytest.
- e2e: puppeteer-core против Chrome на `:8081` после `docker compose up -d --build`. Скрипты лежат в scratchpad.
- Лимиты: `timeout` в секундах, `ram_usage` в МБ (10⁶ байт). `None` и `0` выключают.
- Флаги компиляции: `-std=c++20 -O1`, `-Wl,--max-memory=1073741824`. Для линта `-fsyntax-only -fno-color-diagnostics`.
- Расширения C++: `.cpp .cc .cxx .h .hpp`.
- C++-пакеты: не больше 2000 файлов и 32 МБ на пакет. Скачивание по 8 параллельно.
- Общие лимиты: проверка 30 с, обычный запуск 120 с, вывод 1 000 000 байт.
- Сервер не меняется, кроме имён.
- Код как можно проще, комментарии по плотности как в соседнем коде.

## Review Focus

1. **C++-решение в проверке читает больше ввода, чем дал тест.** Оно должно получить EOF и вернуть напечатанное, а не висеть до 30 с. Тест в задаче 12.
2. **Решение на Python ловит `KeyboardInterrupt` голым `except`.** `TimeLimitExceeded` всё равно должен прийти, по замеру времени. Тест в задаче 4.
3. **Перенос хранилища прервали на середине.** Если есть и `pycode:x`, и `polycode:x`, новая база не перезаписывается, а старая удаляется только после успешной копии. Тест в задаче 2.
4. **Вывод C++ с кириллицей, разрезанной между `write`.** Он не должен превращаться в `�`. Тест в задаче 9.
5. **C++-пакет без заголовков или несуществующий репозиторий.** Статус error с текстом, линт и запуск продолжают работать. Тест в задаче 11.

---

### Task 1: Переименование в polycode

**Files:**
- Modify:
  - все совпадения `pycode`, `pycoder` и `python-coder` в `frontend/src/**`, `frontend/public/{sw.js,manifest.webmanifest,preview.html}`, `frontend/index.html`, `frontend/nginx.conf`, `frontend/package.json` (`"name": "polycode"`), `frontend/scripts/*.mjs`;
  - `backend/go.mod` и все импорты, `backend/**/*.go`;
  - `docker-compose.yml`, `README.md`, `CLAUDE.md`.
- Исключения: `LEGACY_DB` и ключи `python-coder:code`/`python-coder:packages` в `project.ts` остаются как есть, это чтение старых данных.
- Test:
  - `frontend/src/lib/project/access.test.ts`;
  - `frontend/src/python/tests/test_checker.py` (новый).

**Interfaces:**
- Produces:
  - `RESERVED = ".polycode.env"`, `LEGACY_ENV = ".pycode.env"` в `access.ts`;
  - `isReserved(path: string): boolean`, true для обоих имён в корне;
  - Python-пакет `polycode` (`installSources(py, "polycode", …)`), модуль `polycode_test` и алиас `sys.modules["pycode_test"]` на тот же объект;
  - `window.__polycode`, флаг `localStorage["polycode:e2e"]`.

- [ ] **Step 1: Failing tests**
  - `access.test.ts`: `isReserved(".polycode.env")`, `isReserved(".pycode.env")` → true; `isReserved("a/.pycode.env")` → false.
  - `files.test.ts`: `openArchive` с архивом, где только `.pycode.env` с `hidden t.test.py`, делает `t.test.py` скрытым.
  - `test_checker.py` (unittest): `run_tests` с тестом `import pycode_test` и `import polycode_test` проходит. Оба имени — один объект: `assert pycode_test is polycode_test`.
- [ ] **Step 2:** Run `npx vitest run` и unittest → FAIL.
- [ ] **Step 3: Переименование**
  - Сначала `grep -rn "pycode\|pycoder\|python-coder" --exclude-dir=node_modules --exclude-dir=pyodide`.
  - Менять: тексты, ключи (`polycode:*`), имена баз (`polycode:<docId>`, `polycode:blobs`), кэш SW `polycode-v1`.
  - В `docker-compose.yml`:
    - `name: polycode`;
    - пользователь, пароль по умолчанию и база Postgres `polycode`;
    - volume `polycode-db`;
    - `DATABASE_URL` соответственно.
  - В `checker.py`: `helper` регистрируется под обоими именами и удаляется из обоих в `finally`.
  - При импорте архива `.polycode.env` имеет приоритет над `.pycode.env`. Экспорт пишет `.polycode.env`.
- [ ] **Step 4:** Все проверки из Global Constraints и Go-тесты → PASS. Затем `docker compose up -d --build`; приложение открывается на :8081, заголовок polycode.
- [ ] **Step 5: Commit** — `Rename to polycode`

### Task 2: Перенос хранилища

**Files:**
- Modify:
  - `frontend/src/lib/storage.ts`;
  - `frontend/src/main.tsx` (вызвать до рендера);
  - `frontend/src/lib/project/project.ts` (`localStore` ждёт перенос).
- Test: `frontend/src/lib/storage.test.ts`.

**Interfaces:**
- Produces:
  - `renameLocalKeys(storage: Pick<Storage, "length" | "key" | "getItem" | "setItem" | "removeItem">): void`. Ключи `pycode:*` → `polycode:*`, ключ `python-coder:theme` → `polycode:theme`. Существующий новый ключ не перезаписывается, старый удаляется в любом случае.
  - `migrateStorage(): Promise<void>`. Вызывает `renameLocalKeys(localStorage)` в try/catch. Затем для каждой базы `pycode:*` из `indexedDB.databases()`: если базы с новым именем нет, она копируется (`copyDatabase(from, to)`: все object store с `keyPath`/`autoIncrement` и все записи с ключами), и только после успешной копии старая удаляется. Ошибки глотаются, старые данные остаются.

- [ ] **Step 1: Failing tests** (Map-фейк Storage):
  - `pycode:md-mode=split` → `polycode:md-mode=split`, старого ключа нет;
  - при существующем `polycode:x=new` и `pycode:x=old` остаётся `new`, `pycode:x` удалён (Review Focus 3);
  - `python-coder:theme` → `polycode:theme`; `python-coder:code` не трогается.
- [ ] **Step 2:** `npx vitest run src/lib/storage.test.ts` → FAIL.
- [ ] **Step 3: Реализация** в `storage.ts`. `main.tsx`: `await migrateStorage()` перед `createRoot(...).render`.
- [ ] **Step 4:** vitest → PASS. e2e `tmigrate.mjs`:
  1. в странице до загрузки приложения (`evaluateOnNewDocument` на первом заходе) создать через `y-indexeddb` базы `pycode:structure` и `pycode:f:<id>` с файлом `old.py`, плюс `localStorage["pycode:md-mode"]="preview"`;
  2. перезагрузить страницу;
  3. проверить: `old.py` есть в дереве, `localStorage["polycode:md-mode"]==="preview"`, баз `pycode:*` больше нет.
- [ ] **Step 5: Commit** — `Move old browser storage to polycode keys`

### Task 3: Packages по языку

**Files:**
- Modify: `frontend/src/lib/project/project.ts`, `frontend/src/App.tsx` (табы около строки 729, сброс вида).
- Test: `frontend/src/lib/project/files.test.ts`.

**Interfaces:**
- Produces:
  - `languageOf` знает `"cpp"`: расширения `.cpp .cc .cxx .h .hpp`, тип `Language` расширен;
  - `isCpp(path: string): boolean`;
  - `packagesKind(path: string): "python" | "cpp" | null` — `"python"` для `.py`, `"cpp"` для C++, иначе `null`.

- [ ] **Step 1: Failing test**: `packagesKind("a/b.py")==="python"`, `packagesKind("x.hpp")==="cpp"`, `packagesKind("index.html")===null`, `languageOf("main.cc")==="cpp"`.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3: Реализация**
  - Таб Packages рендерится только при `packagesKind(active) !== null`.
  - До задачи 11 для `"cpp"` вкладку не показывать: временно `=== "python"`. Задача 11 включает cpp.
  - `useEffect`: если `view === "packages"` и вкладки нет, `setView("editor")`.
- [ ] **Step 4:** vitest → PASS. e2e: на `main.py` таб есть, на `README.md` нет; если открыт Packages и выбран `.md` в дереве, вид становится Code.
- [ ] **Step 5: Commit** — `Show Packages only for Python files`

### Task 4: Лимиты и замеры в `polycode_test.run`

**Files:**
- Modify:
  - `frontend/src/python/checker.py`;
  - `frontend/src/workers/protocol.ts`;
  - `frontend/src/workers/runner.worker.ts`;
  - `frontend/src/lib/python/runner-client.ts`;
  - `frontend/src/components/check-results.tsx`;
  - `frontend/src/lib/i18n.ts`.
- Test: `frontend/src/python/tests/test_checker.py`.

**Interfaces:**
- Produces (Python, `checker.py`):
  - `class TimeLimitExceeded(TimeoutError)` и `class MemoryLimitExceeded(MemoryError)`, атрибуты `used: float`, `limit: float` (секунды или байты);
  - `run(stdin: str = "", timeout: float | None = None, ram_usage: float | None = None) -> str`;
  - модульные хуки, заменяемые в тестах: `_deadline(ms: int) -> None` (по умолчанию `js.polycode_deadline`), `_now() -> float = time.perf_counter`;
  - `run_tests(...)` возвращает элементы `{"name", "ok", "message", "time"?, "memory"?}`.
- Produces (TS):
  - `CheckResult` получает `time?: number; memory?: number`;
  - `RunnerEvent` получает `{ type: "deadline"; ms: number }` (0 снимает таймер);
  - `RunnerClient` по `deadline` ставит или снимает таймер, срабатывание вызывает `interrupt()`.

- [ ] **Step 1: Failing tests** (`_deadline` заменён на no-op, решение пишется во временную папку):
  - `test_time_limit`: решение `while True: pass`, `_deadline` через `threading.Timer` вызывает `_thread.interrupt_main()` через `ms`; `run(timeout=0.2)` бросает `TimeLimitExceeded`; `_failure(err, tests)` начинается с `"time limit 0.2 s exceeded: "` и кончается на `" s"`.
  - `test_time_limit_swallowed` (Review Focus 2): решение `try:\n while True: pass\nexcept BaseException: pass`, и `_now` возвращает 0, затем 5. Ожидается `TimeLimitExceeded`.
  - `test_memory_limit`: решение `x = bytearray(30_000_000)`, `run(ram_usage=10)` бросает `MemoryLimitExceeded`; сообщение начинается с `"memory limit 10 MB exceeded: "`.
  - `test_measures`: тест-файл `def test_a(): polycode_test.run("", timeout=5, ram_usage=100)`; результат содержит `time` (float ≥ 0) и `memory` (int > 0).
  - `test_no_limits_no_measures`: `run("")` без лимитов → в результате нет ключей `time` и `memory`.
- [ ] **Step 2:** unittest → FAIL.
- [ ] **Step 3: Реализация `checker.py`**
  - Счётчики теста `_measures: dict` обнуляются перед каждым `fn()` и подмешиваются в результат, если не пусты.
  - `time` — сумма по вызовам, `memory` — максимум.
  - `tracemalloc.start()` / `get_traced_memory()[1]` / `stop()` только при `ram_usage`.
  - `_failure` для этих двух классов собирает текст из `float(err.used)` и `float(err.limit)`; при ошибке `float()` — имя типа.
  - Формат: `f"time limit {limit:g} s exceeded: {used:.2f} s"` и `f"memory limit {limit/1e6:g} MB exceeded: {used/1e6:.1f} MB"`.
- [ ] **Step 4: Реализация TS**
  - Воркер: `self.polycode_deadline = (ms) => post({type: "deadline", ms})` до проверки.
  - Клиент: таймер на `ms` вызывает `interrupt()`, `ms === 0` снимает.
  - `CheckResults`: справа в строке `0.12 s · 3.4 MB`, части только при наличии. Формат памяти `(bytes/1e6).toFixed(1) + " MB"`, времени `time.toFixed(2) + " s"`.
- [ ] **Step 5:** unittest и vitest → PASS. e2e `tlimits.mjs`:
  - треугольник из прошлых примеров, тест `run("3\n4\n5\n", timeout=1, ram_usage=50)` → строка показывает `s` и `MB`;
  - второй тест на решении `while True: pass` с `timeout=1` → `time limit 1 s exceeded` меньше чем за 5 с.
- [ ] **Step 6: Commit** — `Time and memory limits in polycode_test.run`

### Task 5: `polycode_test.module`

**Files:**
- Modify: `frontend/src/python/checker.py`.
- Test: `frontend/src/python/tests/test_checker.py`.

**Interfaces:**
- Produces:
  - параметр `run_tests(project, solution, source, kind="python")`, `kind: "python" | "cpp"` (задача 12 передаёт `"cpp"`);
  - `polycode_test.module`, ленивый, через `__getattr__` у `helper`, кэш на проверку;
  - `declarations(source: str, filename: str) -> types.ModuleType`.

- [ ] **Step 1: Failing tests**
  - Решение:
    ```python
    import math
    EPS = 1e-9
    a = float(input())
    def triangulate(x, y, z): return x + y > z + EPS
    class P: pass
    print("hi")
    ```
    Тест `assert polycode_test.module.triangulate(3, 4, 5)` проходит, `hasattr(module, "a")` false, `P` есть, в stdout ничего.
  - `X = compute()` не попадает (вызов в правой части).
  - `if __name__ == "__main__": main()` не выполняется.
  - Для `kind="cpp"` обращение к `module` даёт результат теста `"TypeError"`.
- [ ] **Step 2:** unittest → FAIL.
- [ ] **Step 3: Реализация**
  - Фильтр верхнего уровня по типам из спеки (§3.2).
  - `Assign`/`AnnAssign` берутся, если `not any(isinstance(n, ast.Call) for n in ast.walk(node.value))`; `AnnAssign` без value тоже.
  - Затем `compile(ast.Module(body=kept, type_ignores=[]), path, "exec")` и `exec` в `types.ModuleType(stem)`.
- [ ] **Step 4:** unittest → PASS. e2e: в `tlimits.mjs` добавить тест `module.triangulate`.
- [ ] **Step 5: Commit** — `polycode_test.module: the solution's declarations`

### Task 6: Spike C++ (код выбрасывается)

**Files:**
- Create: только в scratchpad (`spike-cpp/`). Записать результаты в §4 спеки (`docs/superpowers/specs/2026-10-30-polycode-cpp-design.md`).

- [ ] **Step 1: Компиляция clang в браузере.** Страница на vite-сервере с COOP/COEP:
  - воркер импортирует `@yowasp/clang`, компилирует `#include <iostream>` + `std::cin >> n` + `throw`/`catch`;
  - записать время загрузки, время компиляции, ошибки, работают ли исключения.
- [ ] **Step 2: Запуск в WASI-шиме.**
  - `@bjorn3/browser_wasi_shim` запускает результат;
  - кастомный `Fd` на stdin блокируется на SAB;
  - `PreopenDirectory("/project")` читается через `ifstream`.
- [ ] **Step 3: `tracemalloc` в Pyodide.** `import tracemalloc; tracemalloc.start()` в Pyodide из `public/pyodide` работает.
- [ ] **Step 4: Вложенный воркер.**
  - Из воркера создать вложенный воркер, отправить ему wasm и сразу `Atomics.wait(sab, 0, 0, 2000)`;
  - вложенный воркер стартует и отвечает, `while(1)` прерывается `terminate()` после таймаута;
  - проверить в Chrome и в WebKit (Playwright из scratchpad).
- [ ] **Step 5: Записать в спеку**
  - результаты и выбранные флаги (`-fno-exceptions`, если исключения не работают);
  - выбранный путь проверки C++ (вложенный воркер или fallback).
  - Если clang не работает в браузере вообще — остановиться и сообщить пользователю.
- [ ] **Step 6: Commit** — `Spec: C++ spike results`

### Task 7: Языки проекта и выбор языка

**Files:**
- Create: `frontend/src/components/language-dialog.tsx`.
- Modify:
  - `frontend/src/lib/project/project.ts`;
  - `frontend/src/App.tsx`;
  - `frontend/src/hooks/use-file-drop.ts`;
  - `frontend/src/lib/i18n.ts`;
  - `CLAUDE.md`.
- Test: `frontend/src/lib/project/files.test.ts`.

**Interfaces:**
- Produces (`project.ts`):
  - `type ProjectLanguage = "python" | "cpp"`;
  - `languagesOf(s: ProjectStore): ProjectLanguage[]` — `stateOf(s).get("languages")`, иначе вывод из файлов, пусто → `["python"]`;
  - `addLanguagesFor(s: ProjectStore, paths: string[]): void` — добавляет недостающие языки по расширениям (`.py`, C++). Вызывается в `createFile`, `addFiles` и `openArchive`;
  - `needsLanguage(s: ProjectStore): boolean` — нет файлов и нет `languages`;
  - `STARTERS: Record<ProjectLanguage, { path: string; code: string }>` — `main.py` (текущий `DEFAULT_CODE`) и `main.cpp`. Шаблон C++: `#include <iostream>`, `#include <string>`, чтение имени через `std::getline(std::cin, name)`, вывод `Hello, <name>!`;
  - `startProject(s: ProjectStore, lang: ProjectLanguage): void` — пишет `languages: [lang]` и стартовый файл;
  - `resetProject(s)` больше не создаёт файл и удаляет `languages`, поэтому снова появится выбор;
  - `setUp` в `localStore` без старых данных оставляет проект пустым.
- Produces (UI): `LanguageDialog({ open, onChoose: (lang: ProjectLanguage) => void })`. Закрытие диалога = `onChoose("python")`.

- [ ] **Step 1: Failing tests**
  - Пустой стор: `needsLanguage` true, `languagesOf` = `["python"]`.
  - `startProject(s, "cpp")`: файл `main.cpp`, `languagesOf` = `["cpp"]`.
  - `createFile(s, "a.py")` после этого: `["cpp", "python"]` (порядок добавления).
  - Удаление `a.py` язык не убирает.
  - Старый проект без `languages`, но с `x.cpp` и `y.py`: оба языка.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3: Реализация модели**, затем App:
  - Диалог показывается, если `needsLanguage(store)`, мы не гость сессии (`!provider || provider.isOwner`) и стор готов.
  - Ruff, tools-воркер и `runner.ready()` прогреваются только при `languagesOf(store).includes("python")`; найти места прогрева в App.
  - `languages` читается реактивно через `structure.on("update")`, как `rulesOf` в `use-access.ts`.
- [ ] **Step 4:** vitest → PASS. e2e:
  - чистый профиль → диалог;
  - выбор C++ → `main.cpp` открыт, в сети нет запросов к `/pyodide/`;
  - «Новый проект» → диалог снова;
  - гость сессии диалог не видит.
- [ ] **Step 5: Commit** — `Project languages: choose Python or C++ for a new project`

### Task 8: Clang-воркер, подсветка и линтер C++

**Files:**
- Create:
  - `frontend/src/workers/cpp.worker.ts`;
  - `frontend/src/lib/cpp/client.ts`;
  - `frontend/src/lib/cpp/diagnostics.ts`;
  - `frontend/src/lib/cpp/diagnostics.test.ts`.
- Modify:
  - `frontend/src/lib/monaco-core.ts`: `import 'monaco-esm/languages/definitions/cpp/register.js'` (путь проверить в `node_modules/monaco-editor/esm/vs/languages/definitions/cpp`);
  - `frontend/src/components/code-editor.tsx`: lint-эффект около строки 153;
  - `frontend/src/App.tsx`;
  - `frontend/package.json`;
  - `frontend/nginx.conf`: gzip для `application/wasm` и `application/x-tar`;
  - `frontend/public/sw.js`: `/assets/` уже cache-first, проверить, что wasm clang лежит там.

**Interfaces:**
- Produces:
  - `interface ClangDiagnostic { line: number; col: number; severity: "error" | "warning"; message: string }`;
  - `parseClangDiagnostics(log: string, entry: string): ClangDiagnostic[]` — только диагностика для `entry`. Для ошибки в другом файле из цепочки `In file included from <entry>:L:` берётся строка `L` entry, `col` = 1, сообщение `"<file>:<line>: <message>"`. `note` отбрасываются;
  - `type CppPackageFiles = { files: Record<string, string>; includes: string[] }` — пути внутри `/packages/...`;
  - `cppClient.lint(files: ProjectFiles, entry: string, pkgs: CppPackageFiles): Promise<ClangDiagnostic[]>`;
  - `cppClient.compile(files: ProjectFiles, entry: string, pkgs: CppPackageFiles): Promise<{ wasm: Uint8Array | null; log: string }>`;
  - `cppClient.status: "idle" | "loading" | "ready"` и событие для статусбара «Loading C++ compiler…»;
  - `CodeEditor` получает проп `lintCpp?: (text: string) => Promise<ClangDiagnostic[]>`.
- Протокол воркера:
  - запрос `{ id; kind: "lint" | "compile"; files; entry; pkgs }`;
  - ответ `{ id; log: string; wasm?: Uint8Array }`;
  - запросы обрабатываются по очереди. Сначала проверить, что `runClang` из `@yowasp/clang` можно вызывать много раз, иначе пересоздавать инстанс.

- [ ] **Step 1: Failing tests** (`diagnostics.test.ts`)
  - `"main.cpp:3:5: error: expected ';' after expression"` → `{line: 3, col: 5, severity: "error", message: "expected ';' after expression"}`;
  - `warning` распознаётся;
  - `note` отброшен;
  - цепочка `In file included from main.cpp:2:\n./lib.h:4:1: error: unknown type name 'foo'` → `{line: 2, col: 1, severity: "error", message: "lib.h:4: unknown type name 'foo'"}`;
  - ошибка только в `other.cpp` без цепочки к entry → `[]`.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3: Реализация**
  - `npm i @yowasp/clang` (версия из spike).
  - В воркере файлы проекта лежат под `/project/`, команда `clang++ <flags> /project/<entry>` с `-I/project/<dir(entry)> -I/project` и `-I` пакетов. Пути в логе приводятся к относительным (обрезается `/project/`).
  - В `code-editor.tsx` при `language === "cpp"` и наличии `lintCpp` диагностика идёт в те же маркеры: `source: "clang"`, warning → `MarkerSeverity.Warning`. Debounce 500 мс для cpp.
  - App передаёт `lintCpp`: файлы через `projectFiles(store, provider, active)`, пакеты из задачи 11 (до неё `{files: {}, includes: []}`).
  - Кнопки Format, Debug и «Подсказки» для cpp выключены, как для прочих не-Python файлов.
- [ ] **Step 4:** vitest → PASS. e2e `tcpplint.mjs`: в `main.cpp` строка без `;` → через ≤ 60 с (первая загрузка) появляется маркер Monaco на этой строке; исправление его убирает. Подсветка: ключевое слово `int` имеет токен `keyword`.
- [ ] **Step 5: Commit** — `C++: highlighting and clang diagnostics`

### Task 9: Запуск C++

**Files:**
- Create:
  - `frontend/src/workers/cpp-run.worker.ts`;
  - `frontend/src/lib/cpp/runner-client.ts`;
  - `frontend/src/lib/cpp/wasi.ts` — stdin/stdout `Fd`;
  - `frontend/src/lib/cpp/wasi.test.ts`.
- Modify:
  - `frontend/src/App.tsx`: `run()` около строки 340, `runnable` на строке 284;
  - `frontend/src/workers/protocol.ts`;
  - `frontend/src/lib/i18n.ts`;
  - `frontend/package.json`.

**Interfaces:**
- Consumes: `cppClient.compile` (задача 8), `RunnerBuffers` и `STDIN_*` (protocol.ts).
- Produces:
  - `CppRunRequest = { type: "run"; wasm: Uint8Array; files: ProjectFiles; cwd: string; buffers: RunnerBuffers } | { type: "batch"; wasm: Uint8Array; files: ProjectFiles; cwd: string; stdin: string; result: SharedArrayBuffer }`;
  - события `RunnerEvent` (`stdout`/`stderr`/`input_request`/`exit`);
  - `class Utf8Out { push(bytes: Uint8Array): string; flush(): string }` в `wasi.ts` — декодер со `stream: true`;
  - `class CppRunnerClient` с методами `run(wasm, files, entry): Promise<number>`, `on(listener)`, `sendLine(text)`, `sendEof()` и `interrupt()`. `interrupt` делает `terminate()`, создаёт новый воркер и шлёт событие `exit` с `code: 130` и stderr `"\nKeyboardInterrupt\n"`, как Python;
  - `cppRunner` — синглтон.

- [ ] **Step 1: Failing tests** (`wasi.test.ts`, Review Focus 4): `"Привет"` в UTF-8 разрезан посередине буквы на два `push` → склейка равна `"Привет"`; `flush()` отдаёт остаток.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3: Воркер**
  - `npm i @bjorn3/browser_wasi_shim`.
  - Режим `run`: stdin-`Fd` при пустом буфере шлёт `input_request` и ждёт `Atomics.wait` на `control[0]`, как `runner.worker.ts` (`STDIN_READY` / `STDIN_EOF`).
  - Файлы в `PreopenDirectory("/project")`, cwd через env `PWD` и аргумент.
  - Вывод режется на 1 000 000 байт с `reason: "output_limit"`.
  - `exit` с кодом `proc_exit` или 0.
  - Таймаут 120 с — в клиенте, через `interrupt()`.
- [ ] **Step 4: App**
  - `runnable` включает `"cpp"`.
  - В `run()` для cpp:
    1. статус `t("run.compiling")`;
    2. `cppClient.compile`;
    3. лог при ошибке → `appendTerminal(doc, "stderr", log)` и `setRunStatus(doc, "finished", {code: 1, …})`;
    4. иначе `cppRunner.run` и тот же `mirrorRun`.
  - `mirrorRun` должен принимать любой клиент с `on`, `sendLine`, `sendEof`, `interrupt`. Вынести такой интерфейс `ProgramRunner` в `protocol.ts`, если сейчас там конкретный `RunnerClient`.
  - Сигналы `stdin`/`eof`/`stop` от других участников идут в активный клиент.
- [ ] **Step 5:** vitest → PASS. e2e `tcpprun.mjs`:
  - шаблон C++ → ввести `Ann` → `Hello, Ann!`;
  - `while(true){}` → Stop → `KeyboardInterrupt` ≤ 2 с, повторный запуск работает;
  - ошибка компиляции → красный лог;
  - в сессии второй участник вводит строку, она доходит до программы;
  - гость сессии видит `languages` с `cpp`, у него загружается clang, и линт `main.cpp` работает.
- [ ] **Step 6: Commit** — `C++: run programs in the browser`

### Task 10: Синтаксическое дерево и блок-схема C++

**Files:**
- Create:
  - `frontend/src/lib/cpp/parse.ts`;
  - `frontend/src/lib/cpp/tree.ts`;
  - `frontend/src/lib/cpp/flow.ts`;
  - `frontend/src/lib/cpp/flow.test.ts`;
  - `frontend/scripts/copy-tree-sitter.mjs`.
- Modify:
  - `frontend/src/lib/ast.ts`: `categorize`;
  - `frontend/src/components/ast-dialog.tsx`;
  - `frontend/src/App.tsx`: кнопка дерева на строке 795;
  - `frontend/package.json`: `predev`/`prebuild`;
  - `.gitignore`: `public/tree-sitter/`;
  - `frontend/src/lib/i18n.ts`.

**Interfaces:**
- Produces:
  - `parseCpp(code: string): Promise<Tree>` — `web-tree-sitter`. В браузере грамматика из `/tree-sitter/tree-sitter-cpp.wasm`, в node (vitest) из `node_modules`;
  - `cppTree(code: string): Promise<AstResponse>`;
  - `cppFlow(code: string, lang: "en" | "ru"): Promise<FlowResponse>`;
  - `categorize(type: string, lang: "python" | "cpp" = "python"): AstCategory`.

- [ ] **Step 1: Failing tests** (`flow.test.ts`)
  - `int main(){int n; std::cin>>n; if(n>0){std::cout<<n;} else {return 1;} for(int i=0;i<n;i++){} }`:
    - есть группа `main` (`kind: "function"`);
    - узлы `io` ×2, `decision` ×1 с рёбрами `yes` и `no`, `loop` ×1 с ребром `repeat`, `return` ×1;
    - `start` и `end`.
  - Вызов `f()` из `main` при определённой `int f(){return 1;}` → ребро `kind: "call"` к группе `f`.
  - `struct P { void m(){} };` → группа `class` `P` и группа `method` `m` с `parent` = `P`.
  - `int main( {` → `cppFlow` и `cppTree` возвращают `ok: false` и `error.line === 1`.
  - `cppTree("int x = 1;")`:
    - корень `translation_unit`;
    - есть узел `number_literal` с `fields.value === "1"`;
    - `categorize("number_literal", "cpp") === "literal"`, `categorize("if_statement", "cpp") === "statement"`.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3: Реализация**
  - `npm i web-tree-sitter tree-sitter-cpp`. Если у `tree-sitter-cpp` нет wasm в пакете — `tree-sitter-wasms`, версия совместимая с `web-tree-sitter`, проверить загрузкой.
  - Скрипт копирует `web-tree-sitter.wasm` и `tree-sitter-cpp.wasm` в `public/tree-sitter/`.
  - Обход для блок-схемы повторяет структуру `flow.py`: последовательность, `preds` → `link`; группы, `MAX_NODES`, `truncated`.
  - Подписи en/ru — маленькая таблица в `flow.ts`; `label` — текст узла, сокращённый как `_short` (60 символов).
- [ ] **Step 4: Диалог.** `AstDialog` получает `language: "python" | "cpp"`; для cpp вызывает `cppTree`/`cppFlow` вместо `callTool`. Кнопка дерева активна для `python` и `cpp`.
- [ ] **Step 5:** vitest → PASS. e2e: на `main.cpp` открыть дерево → видны узлы. Блок-схема → карточки «Ввод / вывод», «Условие». Клик по карточке выделяет строку в редакторе (`onReveal`).
- [ ] **Step 6: Commit** — `C++: syntax tree and flowchart`

### Task 11: Пакеты C++

**Files:**
- Create:
  - `frontend/src/lib/cpp/packages.ts`;
  - `frontend/src/lib/cpp/packages.test.ts`;
  - `frontend/src/hooks/use-cpp-packages.ts`;
  - `frontend/src/components/cpp-packages-panel.tsx`.
- Modify:
  - `frontend/src/lib/project/project.ts`;
  - `frontend/src/App.tsx`: таб Packages для cpp, `lintCpp` и `compile` получают пакеты;
  - `frontend/public/sw.js`;
  - `frontend/src/lib/i18n.ts`.

**Interfaces:**
- Produces:
  - `interface CppPackage { spec: string; repo: string; ref: string | null; version?: string; include?: string; status: "installing" | "installed" | "error"; error?: string }`;
  - `cppPackagesOf(s: ProjectStore): Y.Array<CppPackage>` (`structure.getArray("cppPackages")`);
  - `parseCppSpec(input: string): { repo: string; ref: string | null; spec: string } | null` — `^([\w.-]+\/[\w.-]+)(?:@([\w./+-]+))?$`;
  - `pickInclude(paths: string[]): string` — `"include"`, `"single_include"` или `""`;
  - `headerFiles(paths: string[], include: string): string[]` — внутри include-пути, расширения `.h .hpp .hh .hxx .ipp .inl .tpp` или без расширения;
  - `fetchCppPackage(repo: string, version: string | null): Promise<{ version: string; include: string; files: Record<string, string> }>` — ошибки бросаются с понятным текстом: `"not found"`, `"no headers"`, `"too large"`;
  - `loadCppPackages(list: CppPackage[]): Promise<CppPackageFiles>` — кэш в памяти по `repo@version`; файлы ключуются `/packages/<repo>/<path>`, `includes` = `/packages/<repo>/<include>`;
  - `useCppPackages(shared)` с методами `add`, `remove`, `retry` — как `usePackages`, версия фиксируется после первой установки.

- [ ] **Step 1: Failing tests**
  - `parseCppSpec("nlohmann/json@v3.11.3")` → `{repo: "nlohmann/json", ref: "v3.11.3"}`; `parseCppSpec("json")` → null.
  - `pickInclude(["include/nlohmann/json.hpp", "README.md"]) === "include"`; `pickInclude(["single_include/a.hpp"]) === "single_include"`; `pickInclude(["a.h"]) === ""`.
  - `headerFiles(["include/Eigen/Dense", "include/x.cpp", "include/a.hpp", "docs/a.h"], "include")` → `["include/Eigen/Dense", "include/a.hpp"]`.
  - Review Focus 5: `fetchCppPackage` с замоканным `fetch`:
    - 404 на `resolved` → reject `"not found"`;
    - список без заголовков → reject `"no headers"`.
- [ ] **Step 2:** vitest → FAIL.
- [ ] **Step 3: Реализация**
  - URL из спеки §6.
  - Лимиты 2000 файлов / 32 МБ: проверяются по `size` из flat-списка до скачивания.
  - Скачивание по 8 параллельно.
- [ ] **Step 4: Service worker.** В `IMMUTABLE` добавить:
  - `cdn.jsdelivr.net` с `/gh/`, если путь содержит `@`;
  - `data.jsdelivr.com` с `/v1/packages/gh/`, если в пути есть `@`.
- [ ] **Step 5: Панель и таб.** Панель повторяет `PackagesPanel`: поле, список, Retry, только админ. Таб Packages для cpp включается (`packagesKind(active) !== null`).
- [ ] **Step 6:** vitest → PASS. e2e `tcpppkg.mjs`:
  - добавить `nlohmann/json@v3.11.3`;
  - программа с `#include <nlohmann/json.hpp>` печатает `json::parse("{\"a\":1}")["a"]` → `1`;
  - `foo/doesnotexist` → статус error, линт `main.cpp` работает.
- [ ] **Step 7: Commit** — `C++ packages: header-only libraries from GitHub`

### Task 12: Проверка C++ решений

**Files:**
- Modify:
  - `frontend/src/App.tsx`: `testPath` на строке 382, `checkHere`;
  - `frontend/src/lib/python/runner-client.ts`: `check(…, wasm?)`;
  - `frontend/src/workers/runner.worker.ts`: `check`, хук `polycode_run_wasm`;
  - `frontend/src/workers/cpp-run.worker.ts`: режим `batch`;
  - `frontend/src/python/checker.py`;
  - `frontend/src/lib/project/project.ts`;
  - `frontend/src/lib/i18n.ts`;
  - `CLAUDE.md`.
- Test:
  - `frontend/src/lib/project/files.test.ts`;
  - `frontend/src/python/tests/test_checker.py`.

**Interfaces:**
- Consumes: `cppClient.compile` (8), `CppRunRequest` `batch` (9), `run_tests(..., kind)` (5), `TimeLimitExceeded`/`MemoryLimitExceeded` и `_measures` (4).
- Produces:
  - `testPathOf(path: string): string | null` — `a/b.py` → `a/b.test.py`, `a/b.cpp` → `a/b.test.py`, `*.test.py` и прочее → null;
  - `RunnerRequest` `check` получает `wasm?: Uint8Array`;
  - JS-хук `polycode_run_wasm(stdin: string, timeoutMs: number) → { stdout: string; memory: number; timedOut: boolean }`;
  - Python-хук `_run_wasm(stdin, timeout_ms) -> dict` в `checker.py`, заменяемый в тестах.
- Batch SAB: `Int32Array` заголовок `[state, stdoutLen, memory, exitCode]` (16 байт), затем до 1 000 000 байт вывода. `state` 0 → 1 по завершении + `Atomics.notify`.

- [ ] **Step 1: Failing tests**
  - `testPathOf` для перечисленных случаев.
  - `test_checker.py`, решение C++ с фейковым `_run_wasm`:
    - `lambda s, t: {"stdout": s.upper(), "memory": 2_000_000, "timedOut": False}` → `run("ab")` == `"AB"`;
    - `ram_usage=1` → `MemoryLimitExceeded`;
    - `timedOut: True` с `timeout=1` → `TimeLimitExceeded`;
    - без `timeout` хук получает остаток лимита проверки (> 0).
- [ ] **Step 2:** vitest и unittest → FAIL.
- [ ] **Step 3: Python.** `run()` при `kind == "cpp"` зовёт `_run_wasm(stdin, ms)`: `ms` = `timeout*1000`, если задан, иначе 30000. Время меряется вокруг вызова, память = `memory`.
- [ ] **Step 4: Воркер.**
  - `polycode_run_wasm` создаёт `new Worker(new URL("./cpp-run.worker.ts", import.meta.url), {type: "module"})` и шлёт `batch`;
  - `Atomics.wait(state, 0, 0, timeoutMs)`; при таймауте `terminate()`;
  - `TextDecoder` по длине.
  - Если spike (задача 6) выбрал fallback — синхронный запуск в этом же воркере через тот же `wasi.ts`.
  - Batch-stdin: `Fd` читает из строки, в конце EOF (Review Focus 1).
- [ ] **Step 5: App.**
  - `hasTest` через `testPathOf`, кнопка «Проверить» доступна для `.cpp`.
  - `checkHere` для cpp: `cppClient.compile` (с пакетами) → при `wasm === null` `error: t("check.compileFailed", { log: первые 5 строк log })` → иначе `RunnerClient.check(files, path, test, specs, wasm)`.
  - Python-пакеты для тестов грузятся как раньше.
- [ ] **Step 6:** vitest и unittest → PASS. e2e `tcppcheck.mjs`:
  - `main.cpp` (треугольник на `cin`, вывод «Да»/«Нет») + тот же `main.test.py`, что для `main.py` → все тесты зелёные, видны `s`/`MB`;
  - решение с `while(true){}` и `timeout=1` → `time limit 1 s exceeded` меньше чем за 5 с;
  - решение, читающее 4 числа при тесте на 3, завершает тест за < 5 с (не висит);
  - в сессии ученик проверяет `.cpp`, результат приходит от админа.
- [ ] **Step 7: Commit** — `Check C++ solutions with Python tests`

### Task 13: Документация и регрессия

**Files:**
- Modify: `CLAUDE.md`, `README.md`.

- [ ] **Step 1: CLAUDE.md**
  - разделы C++ (воркеры, флаги, пакеты, деревья), языки проекта, `polycode_test` (лимиты, `module`, C++), перенос хранилища;
  - команды: Python unittest, `copy-tree-sitter.mjs`.
- [ ] **Step 2: README** — описание polycode (Python и C++).
- [ ] **Step 3: Регрессия.** Прогнать все e2e из scratchpad (старые t1, t4–t17, treview, tisolate, tsignals, tnumpy, tboard, tmembers, thtml, thtmlmode, и новые), с учётом переименования ключей (`polycode:e2e`, `__polycode`). Всё → PASS.
- [ ] **Step 4: Commit** — `Docs: polycode with C++`
