# Турниры в проверках: план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Цель:** баллы за тесты, остановка на первом падении, таблица лучших результатов, защищённая от решения на Python, и наследование тестов по папкам.

**Архитектура:** турнирный файл определяется разбором `ast` до выполнения. Тесты идут в интерпретаторе без файлов проекта, а `run()` через страницу запускает решение в отдельном воркере по обобщённому пути C++. Таблица хранится в документах `t:<id>`, пишут в неё только администраторы.

**Стек:** Pyodide, TypeScript, React 19, Yjs, vitest, unittest, puppeteer-core.

**Спецификация:** `docs/superpowers/specs/2026-10-31-tournaments-design.md`

## Общие ограничения

- Лимиты: общий на турнирную проверку 120 с (обычная остаётся 30 с); `id` турнира 1–64 символа; лимит вывода 1 000 000 байт на stdout + stderr.
- Все строки интерфейса идут через `t()` с записями `en` и `ru`.
- Сообщения ученику содержат только фиксированный текст и числа; вывод решения в них не попадает.
- Обычные (не турнирные) проверки работают как раньше: те же результаты и тот же формат словарей.
- После `hideSources` запрещён `py.pyimport("polycode.…")`: используйте объект `polycode` в воркере.
- **Коммиты только по просьбе пользователя** (`CLAUDE.md`). В задачах нет шагов коммита; рабочее дерево уже содержит незакоммиченный линтер, его не трогать и не откатывать.
- Команды запускаются с абсолютными путями или из `frontend/`; проверки в конце каждой задачи:
  - `cd /Users/lixelv/Documents/dev/python-coder/frontend && npx tsc -b && npx oxlint src && npx vitest run`
  - `/opt/homebrew/bin/python3.14 -m unittest discover -s /Users/lixelv/Documents/dev/python-coder/frontend/src/python/tests`

## На что смотреть при проверке

Спецификация этого прямо не описывает, но участник с этим столкнётся. У каждого пункта есть тест в задаче, которая владеет кодом.

1. Решение с бесконечным циклом, когда `timeout` не задан: тест падает по времени, остальные пропущены, проверка не зависает (задача 2).
2. Решение читает `sys.stdin.read()` или `os.read(0, …)`, а не `input()`: получает текст теста и конец файла, ничего не блокируется (задача 3 и браузер в задаче 8).
3. Импорт с псевдонимом `from polycode_test import tournament as x`: ошибка файла теста, а не тихая обычная проверка (задача 2).
4. Турнирный файл без функций `test_*`: в таблице не появляется запись с 0 из 0 (задача 5).
5. Решение печатает 2 МБ многобайтового текста: тест падает с `output limit exceeded`, вывод обрезан на границе символа (задача 3).

---

### Задача 1: наследование тестов

**Файлы:**
- Изменить: `frontend/src/lib/project/project.ts:65-70`, `frontend/src/App.tsx:442-450`
- Тест: `frontend/src/lib/project/files.test.ts:214-226`

**Интерфейсы:**
- Даёт: `testPathOf(path: string, files: readonly string[]): string | null`

- [ ] **Шаг 1: заменить тесты `testPathOf` на падающие**

```ts
describe("testPathOf", () => {
  const files = ["a/ivan/tri.py", "a/ivan/tri.test.py", "a/tri.test.py", "tri.test.py", "b/c/tri.py", "b/c/x.cpp", "x.test.py", "lib.hpp", "t.test.py", "README.md"]
  it("takes the nearest test file", () => {
    expect(testPathOf("a/ivan/tri.py", files)).toBe("a/ivan/tri.test.py")
    expect(testPathOf("a/ivan/tri.py", files.filter((f) => f !== "a/ivan/tri.test.py"))).toBe("a/tri.test.py")
  })
  it("goes up to the root", () => {
    expect(testPathOf("b/c/tri.py", files)).toBe("tri.test.py")
    expect(testPathOf("b/c/x.cpp", files)).toBe("x.test.py")
  })
  it("does not look in other folders", () => {
    expect(testPathOf("z/y.py", ["q/y.test.py"])).toBeNull()
  })
  it("gives null for tests, headers and other files", () => {
    expect(testPathOf("t.test.py", files)).toBeNull()
    expect(testPathOf("lib.hpp", ["lib.test.py"])).toBeNull()
    expect(testPathOf("README.md", ["README.test.py"])).toBeNull()
  })
})
```

- [ ] **Шаг 2: убедиться, что тесты падают**

Запуск: `cd /Users/lixelv/Documents/dev/python-coder/frontend && npx vitest run src/lib/project/files.test.ts -t testPathOf`
Ожидается: FAIL.

- [ ] **Шаг 3: реализовать `testPathOf` и обновить вызовы**

Идём от папки решения к корню с помощью `parentOf` и возвращаем первый существующий `<папка>/<имя>.test.py`. В `App.tsx` станет `const testPath = testPathOf(active, allFiles)` и `const hasTest = testPath !== null`. В `checkHere` файл ищем по `Object.keys(rulesOf(store).files)`.

- [ ] **Шаг 4: запустить проверки из раздела «Общие ограничения»**

Ожидается: всё зелёное.

---

### Задача 2: API турнира в `checker.py`

**Файлы:**
- Изменить: `frontend/src/python/checker.py`, `frontend/src/python/stubs/polycode_test.py`
- Тест: `frontend/src/python/tests/test_checker.py`, `frontend/src/python/tests/test_stub.py`

**Интерфейсы:**
- Даёт (Python):
  - `tournament_of(source: str) -> dict | None`: `None`, `{"id": str, "private": bool}` или `{"error": str}`. Синтаксическая ошибка даёт `None`: о ней сообщит `run_tests`.
  - `run_tests(project, solution, source, kind="python", tournament=False) -> list`
  - `_run_outside(stdin: str, timeout_ms: int, trace_memory: bool) -> dict` с полями `stdout, memory, timedOut, exitCode, failure, elapsed` (секунды); вызывает JS `polycode_run_outside(stdin, ms, trace)`.
- Переименования: `_run_cpp` → `_run_isolated`, `_run_wasm` → `_run_outside`, `polycode_run_wasm` → `polycode_run_outside`. В `_failure` параметр `language` заменяется на `isolated: bool = False`.

- [ ] **Шаг 1: выполнить переименования, включая `test_checker.py` и `test_stub.py`**

В тестах обёртка `hook` в `CppChecks.check` получает третий параметр и дополняет ответ заглушки: `result.setdefault("elapsed", checker._now() - started)`. Так прежние проверки времени остаются в силе. `_run_isolated` берёт `used = result["elapsed"]`. Тест `test_real_hook_passes_exit_status_from_the_worker` переходит на `fake.polycode_run_outside = lambda stdin, ms, trace: SimpleNamespace(..., elapsed=0.5)` и ожидает `elapsed` в словаре.

Запуск: команда unittest из «Общих ограничений». Ожидается: OK.

- [ ] **Шаг 2: написать падающие тесты в новом классе `Tournament`**

Заглушка `hook` для `_run_outside` эхо-возвращает `stdin`, вызовы складываются в `self.calls`. Проверки:

```python
def test_tournament_of(self):
    self.assertIsNone(checker.tournament_of("x = 1\n"))
    self.assertIsNone(checker.tournament_of("def (\n"))
    self.assertEqual(checker.tournament_of("import polycode_test as t\nt.tournament('a')\n"), {"id": "a", "private": False})
    self.assertEqual(checker.tournament_of("from polycode_test import tournament\ntournament('a', private=True)\n"), {"id": "a", "private": True})

def test_tournament_of_rejects(self):
    for source in (
        "tournament('a')\ntournament('b')\n",
        "def f():\n    tournament('a')\n",
        "tournament('')\n",
        f"tournament('{'x' * 65}')\n",
        "tournament(1)\n",
        "name = 'a'\ntournament(name)\n",
        "tournament('a', private=1)\n",
    ):
        self.assertIn("error", checker.tournament_of(source), source)

def test_stops_after_the_first_failure(self):
    res = self.check(HEAD + "@t.points(10)\ndef test_a(): pass\n@t.points(30)\ndef test_b(): assert False, 'no'\n@t.points(5)\ndef test_c(): raise SystemExit\n")
    self.assertEqual(
        [(r["name"], r["ok"], r.get("skipped", False), r["points"]) for r in res],
        [("test_a", True, False, 10), ("test_b", False, False, 30), ("test_c", False, True, 5)],
    )
    self.assertEqual(res[1]["message"], "no")

def test_test_without_points_costs_nothing_and_still_stops(self):
    res = self.check(HEAD + "def test_a(): assert False\n@t.points(5)\ndef test_b(): pass\n")
    self.assertEqual(res[0]["points"], 0)
    self.assertTrue(res[1]["skipped"])

def test_tests_above_the_call_count(self):
    res = self.check("import polycode_test as t\n@t.points(2)\ndef test_a(): pass\nt.tournament('x')\n")
    self.assertEqual(res[0]["points"], 2)

def test_ordinary_mode_runs_everything_and_adds_no_fields(self):
    res = checker_run_plain("import polycode_test as t\n@t.points(2)\ndef test_a(): assert False\ndef test_b(): pass\n")
    self.assertEqual([r["name"] for r in res], ["test_a", "test_b"])
    self.assertNotIn("points", res[0])

def test_bad_points_is_an_error_of_the_file(self):
    for amount in ("0", "-1", "True", "'5'", "float('inf')", "float('nan')"):
        res = self.check(HEAD + f"@t.points({amount})\ndef test_a(): pass\n")
        self.assertEqual([r["name"] for r in res], ["tests"], amount)

def test_alias_of_tournament_is_an_error_of_the_file(self):
    res = checker_run_plain("from polycode_test import tournament as x\nx('a')\n")
    self.assertEqual([r["name"] for r in res], ["tests"])
    self.assertIn("tournament", res[0]["message"])

def test_project_stays_out_of_sys_path(self):
    before = list(sys.path)
    self.check(HEAD + "def test_a(): pass\n", project="/nonexistent/project")
    self.assertEqual(sys.path, before)

def test_module_is_a_type_error(self):
    res = self.check(HEAD + "def test_a():\n    t.module\n")
    self.assertEqual(res[0]["message"], "TypeError")

def test_run_goes_through_the_hook(self):
    res = self.check(HEAD + "def test_a():\n    assert t.run('x\\n') == 'x\\n'\n")
    self.assertTrue(res[0]["ok"])
    self.assertEqual(len(self.calls), 1)

def test_endless_solution_without_timeout_fails_and_skips_the_rest(self):
    self.answer = {"stdout": "", "memory": 0, "timedOut": True, "exitCode": 0, "failure": "", "elapsed": 120.0}
    res = self.check(HEAD + "def test_a():\n    t.run()\ndef test_b(): pass\n")
    self.assertIn("time limit", res[0]["message"])
    self.assertTrue(res[1]["skipped"])
    self.assertLessEqual(self.calls[0], 120_000)

def test_exit_code_of_a_python_solution_reaches_the_student(self):
    self.answer = {"stdout": "", "memory": 0, "timedOut": False, "exitCode": 1, "failure": "", "elapsed": 0.0}
    res = self.check(HEAD + "def test_a():\n    t.run()\n")
    self.assertEqual(res[0]["message"], "exit code 1")
```

Здесь `HEAD = "import polycode_test as t\nt.tournament('x')\n"`, `self.check` вызывает `run_tests(project, "main.py", source, tournament=True)`, а `checker_run_plain` вызывает `run_tests(..., tournament=False)`.

В `test_stub.py` проверка параметров `run` теперь сравнивает его с `_run_isolated`. Новый тест требует, чтобы параметры `tournament` и `points` в заглушке совпадали с `checker.py`. Поэтому они объявлены там как функции верхнего уровня `tournament(id, private=False)` и `points(amount)`.

- [ ] **Шаг 3: убедиться, что тесты падают**

Запуск: команда unittest. Ожидается: FAIL, нет `tournament_of`.

- [ ] **Шаг 4: реализовать**

- Константы: `TOURNAMENT_LIMIT = 120`; `_check_limit` (глобальная, задаётся в `run_tests`) заменяет `CHECK_LIMIT` в `_run_isolated`.
- Ошибки файла: `class TestFileError(Exception)` с полем `code`; `FILE_ERRORS = {"place": "tournament() must be one top-level statement", "args": "tournament(id, private=False): id is a string of 1 to 64 characters", "points": "points(amount): amount is a positive number"}`. `_failure` возвращает только значение из этого словаря, для незнакомого `code` — `"error"`, чтобы решение не могло передать свой текст.
- `tournament_of`: `ast.walk` ищет `Call` с `func` вида `Name("tournament")` или `Attribute(attr="tournament")`. Больше одного вызова, или вызов не является `ast.Expr` прямо в `tree.body` — ошибка `place`. Аргументы могут быть только константами `ast.Constant`: `id` строка длиной 1–64, `private` типа `bool`, иначе `args`.
- `helper.tournament(id, private=False)` при выполнении: в турнире ничего не делает, вне турнира бросает `TestFileError("place")`. Так псевдоним становится ошибкой файла.
- `helper.points(amount)`: отвергает `bool`, нечисловые, нулевые, отрицательные значения, бесконечность и NaN (`TestFileError("points")`), записывает цену в `_points[fn]`, возвращает ту же функцию. `_points` очищается в начале `run_tests`.
- В `run_tests`: `isolated = kind == "cpp" or tournament`, `helper.run = _run_isolated if isolated else run`. `module` бросает `TypeError`, если `isolated`. При `tournament=True` папки проекта не добавляются в `sys.path`.
- `_run_isolated` передаёт `trace_memory=bool(ram_usage)`.
- Цикл тестов при `tournament=True`: каждому результату добавляется `"points": _points.get(fn, 0)`; после первого `ok=False` остальные приходят как `{"name", "ok": False, "message": "", "skipped": True, "points"}` без запуска.
- Обновить docstring модуля и заглушку `stubs/polycode_test.py` (`tournament`, `points`, описание `run` в турнире).

- [ ] **Шаг 5: запустить проверки**

Запуск: команда unittest. Ожидается: OK. TypeScript здесь не менялся.

---

### Задача 3: одиночный запуск решения в воркере

**Файлы:**
- Изменить: `frontend/src/python/runner.py`, `frontend/src/workers/protocol.ts`, `frontend/src/workers/runner.worker.ts`, `frontend/src/lib/python/runner-client.ts`. `cpp-run.worker.ts` не меняется: он пишет первые четыре ячейки заголовка и берёт смещение вывода из `BATCH_HEADER_BYTES`, а `started` для C++ ставит страница
- Тест: `frontend/src/python/tests/test_runner.py`

**Интерфейсы:**
- Даёт (Python): `run_batch(path, stdin, arm=None, trace_memory=False) -> dict` с полями `exitCode`, `memory`.
- Даёт (протокол):
  - заголовок `Int32 [state, length, memory, exit, started]`, `BATCH_STARTED = 4`, `BATCH_HEADER_BYTES = 20`;
  - `RunnerRequest`: `{ type: "batch"; files: ProjectFiles; entry: string; specs: string[]; stdin: string; traceMemory: boolean; result: SharedArrayBuffer }`;
  - `RunnerEvent`: `run_wasm` → `run_outside` (добавляется `traceMemory`), `kill_wasm` → `kill_outside`.
- Даёт (страница): `RunnerClient.batch(files, entry, specs, stdin, traceMemory, result): Promise<void>`. При ошибке запуска заголовок получает `BATCH_NOT_STARTED`, `started = 1`, и обе ячейки будятся.

- [ ] **Шаг 1: написать падающие тесты `Batch` в `test_runner.py`**

Во временной папке с `main.py` проверяются:

```python
def test_prompt_is_not_printed_and_eof_is_an_error(self):
    # main.py: print(input("? ")); input()
    self.assertEqual(self.run_batch("x\n")["exitCode"], 1)
    self.assertEqual(self.out(), "x\n")

def test_stdin_read_gets_the_text(self):
    # main.py: import sys; print(sys.stdin.read())
    self.run_batch("a\nb\n")
    self.assertEqual(self.out(), "a\nb\n\n")

def test_exit_codes(self):
    for source, code in (("import sys; sys.exit(3)", 3), ("raise ValueError", 1), ("pass", 0)):
        self.write(source)
        self.assertEqual(self.run_batch("")["exitCode"], code, source)

def test_memory_only_when_traced(self):
    self.write("x = bytearray(10**7)")
    self.assertGreaterEqual(self.run_batch("", trace_memory=True)["memory"], 10**7)
    self.assertEqual(self.run_batch("")["memory"], 0)

def test_restores_input_and_stdin(self):
    saved = builtins.input, sys.stdin
    self.run_batch("")
    self.assertEqual((builtins.input, sys.stdin), saved)

def test_arm_is_called_before_the_program(self):
    events = []
    self.write("import builtins; builtins.polycode_probe = 1")
    self.run_batch("", arm=lambda: events.append(hasattr(builtins, "polycode_probe")))
    del builtins.polycode_probe
    self.assertEqual(events, [False])
```

Вспомогательные методы класса: `self.write(source)` записывает `main.py`, `self.run_batch(stdin, **kw)` вызывает `runner.run_batch("main.py", stdin, **kw)` под `contextlib.redirect_stdout`, а `self.out()` возвращает перехваченное.

- [ ] **Шаг 2: убедиться, что тесты падают**

Запуск: команда unittest. Ожидается: FAIL, нет `run_batch`.

- [ ] **Шаг 3: реализовать `run_batch` в `runner.py`**

`sys.stdin = io.StringIO(stdin)`; `builtins.input` заменяется функцией, которая игнорирует подсказку и бросает `EOFError` в конце текста; при `trace_memory` запускается `tracemalloc`; затем `run_main(path, arm=arm)`. Всё восстанавливается в `finally`.

- [ ] **Шаг 4: запустить unittest**

Ожидается: OK.

- [ ] **Шаг 5: реализовать запрос `batch` в `runner.worker.ts`**

- Модульная переменная `sink: { bytes: Uint8Array; length: number } | null`. Пока она задана, `setStdout` дописывает байты в неё, а не в `Stream`; `stderr` только считается. В `countOutput` запись обрезается по `utf8Boundary` (импорт из `@/lib/cpp/wasi`), при превышении прерывание и `outputLimited` работают как сейчас.
- `readLine` при заданном `sink` сразу возвращает `null` (`os.read(0, …)` получает конец файла и не блокируется).
- `batch(req)`: при первом запросе устанавливает `specs`, `loadImported(files)`, затем удаляет `fetch`, `XMLHttpRequest`, `importScripts`. Затем на каждый запуск: `writeProject(files)`, сброс счётчиков, вызов `run_batch` с `arm`, который вызывает `armInterrupts()`, пишет `started = 1` с `Atomics.notify`, затем `py.checkInterrupt()`.
- В конце (и из `catch`: код 1) записываются длина, память, код, затем `state` (`BATCH_OUTPUT_LIMIT` или `BATCH_EXITED`) с `Atomics.notify`; прерывания снимаются, `sink` очищается.

- [ ] **Шаг 6: реализовать `RunnerClient.batch` и `failBatch`**

`failBatch(result)` — `compareExchange` состояния на `BATCH_NOT_STARTED`, запись `started = 1`, `notify` обеих ячеек; `runWasm.onerror` использует её же. В `runWasm` перед `postMessage` ставится `started = 1`: у C++ время идёт с отправки, как и раньше.

- [ ] **Шаг 7: запустить проверки**

`tsc` и `vitest` должны пройти; события переименованы, но `check()` ещё не использует `batch`. Проверка 2 МБ из раздела «На что смотреть» выполняется в браузере в задаче 8.

---

### Задача 4: подключение турнирной проверки

**Файлы:**
- Изменить: `frontend/src/workers/protocol.ts`, `frontend/src/workers/runner.worker.ts:307-352`, `frontend/src/lib/python/runner-client.ts:138-193`, `frontend/src/App.tsx:447-464`, `frontend/src/lib/i18n.ts` (`check.timeout`)

**Интерфейсы:**
- Потребляет: `tournament_of`, `run_tests(..., tournament=)`, `RunnerClient.batch`.
- Даёт:
  - `CheckResult` получает `skipped?: boolean`, `points?: number`;
  - `type CheckTournament = { id: string; private: boolean }`;
  - `RunnerEvent` `checked` получает `tournament?: CheckTournament`; новое событие `{ type: "tournament" }`;
  - `RunnerClient.check(...)` возвращает `Promise<CheckOutcome>`, где `CheckOutcome = { results: CheckResult[]; tournament?: CheckTournament }`;
  - `TOURNAMENT_TIMEOUT_MS = 120_000` в `runner-client.ts`.

- [ ] **Шаг 1: изменить `check()` в воркере**

Порядок:
1. `tournament_of(test)` разбирается через `polycode.checker`.
2. При `error` постится `checked` с одной строкой `{name: "tests", ok: false, message}`; больше ничего не выполняется.
3. Если турнир, постится `{type: "tournament"}`.
4. Установка `specs`; `loadImported` получает только `{"tests.py": test}` в турнире и `{...files, "tests.py": test}` иначе.
5. Удаление сети.
6. `writeProject(tournament ? {} : files)`.
7. `polycode_run_outside` ставится при `cpp || tournament`.
8. `run_tests.callKwargs(project, solution, test, kind, { tournament: !!tournament })`.

Константа воркера `SOLUTION_BOOT_MS = 60_000`. `runOutside(stdin, timeoutMs, traceMemory)`:
- постит `run_outside`;
- ждёт `started` не дольше `SOLUTION_BOOT_MS`, при истечении постит `kill_outside` и возвращает `failure: "not_started"`;
- затем отсчитывает `performance.now()`, ждёт `state` не дольше `timeoutMs`, при истечении постит `kill_outside` и возвращает `timedOut: true`;
- `elapsed` в секундах считается от `started`.

- [ ] **Шаг 2: изменить `RunnerClient.check`**

- Событие `tournament` перезапускает таймер на `TOURNAMENT_TIMEOUT_MS`.
- Обработчик `run_outside`: при `wasm` вызывается `runWasm`, иначе `this.solution ??= new RunnerClient()`, затем `this.solution.batch(files, solution, specs, event.stdin, event.traceMemory, event.result)`.
- Обработчик `kill_outside`: `killWasm()` и `this.solution?.restart()`. `restart()` тестового клиента делает то же, плюс сбрасывает `this.solution`.

- [ ] **Шаг 3: обновить `checkHere` в `App.tsx` и `check.timeout`**

`checkHere` возвращает результат и `tournament`. Текст таймаута больше не называет число секунд: `en`: `The check took too long and was stopped.`, `ru`: `Проверка шла слишком долго и была остановлена.`

- [ ] **Шаг 4: запустить проверки и сделать промежуточную проверку в браузере**

Пересборка: `docker compose up -d --build frontend` из корня репозитория. В Chrome (`http://localhost:8081`, puppeteer-core) турнирный файл даёт баллы и `skipped` в результате `check`, а решение с `random.py` в проекте не меняет `import random` в тесте. Таблицы пока нет.

---

### Задача 5: данные таблицы

**Файлы:**
- Создать: `frontend/src/lib/tournament.ts`, `frontend/src/lib/tournament.test.ts`
- Изменить: `frontend/src/lib/project/access.ts`, `frontend/src/lib/project/access.test.ts`, `frontend/src/lib/project/store.ts`, `frontend/src/lib/project/store.test.ts`, `frontend/src/lib/project/project.ts`

**Интерфейсы:**
- Даёт (`lib/tournament.ts`):
  - `interface TournamentEntry { name: string; score: number; max: number; passed: string[]; at: number }`
  - `interface Standing { userId: string; name: string; scores: Record<string, number>; total: number; place: number }`
  - `taskOf(testPath: string): string`
  - `entryOf(results: CheckResult[], name: string, at: number): TournamentEntry | null`: `null`, если тестов нет.
  - `resultsOf(doc: Y.Doc): Y.Map<TournamentEntry>`
  - `recordRun(doc: Y.Doc, userId: string, task: string, entry: TournamentEntry): boolean`
  - `standings(results: Record<string, TournamentEntry>): Standing[]`
  - `mayRecord(member: Member, solution: string, testFile: string, rules: Rules): boolean`
- Даёт (`project.ts`): `tournamentsOf(s)`: `Y.Map<{ private: boolean }>`; `ensureTournament(s, id, isPrivate)`: пишет только при отсутствии или смене флага.
- Даёт (`access.ts`): `Rules.tournaments: Record<string, { private: boolean }>`.

- [ ] **Шаг 1: написать падающие тесты**

```ts
// tournament.test.ts
const r = (name: string, ok: boolean, points = 0, skipped = false): CheckResult => ({ name, ok, message: "", points, ...(skipped && { skipped }) })

it("sums the points of passed tests", () => {
  expect(entryOf([r("a", true, 10), r("b", false, 30), r("c", false, 5, true)], "Ann", 7)).toEqual({ name: "Ann", score: 10, max: 45, passed: ["a"], at: 7 })
})
it("makes no entry for a file without tests", () => {
  expect(entryOf([], "Ann", 7)).toBeNull()
})
it("takes the task from the test file's name", () => {
  expect(taskOf("a/ivan/tri.test.py")).toBe("tri")
  expect(taskOf("tri.test.py")).toBe("tri")
})
it("replaces an entry only by a strictly better score", () => {
  const doc = new Y.Doc()
  const entry = (score: number, at: number): TournamentEntry => ({ name: "A", score, max: 40, passed: [], at })
  expect(recordRun(doc, "u", "tri", entry(10, 1))).toBe(true)
  expect(recordRun(doc, "u", "tri", entry(10, 2))).toBe(false)
  expect(recordRun(doc, "u", "tri", entry(5, 3))).toBe(false)
  expect(resultsOf(doc).get("u/tri")!.at).toBe(1)
  expect(recordRun(doc, "u", "tri", entry(20, 4))).toBe(true)
})
it("records a first zero score", () => {
  const doc = new Y.Doc()
  expect(recordRun(doc, "u", "tri", { name: "A", score: 0, max: 10, passed: [], at: 1 })).toBe(true)
})
it("ranks by sum, then by who reached it earlier", () => {
  const e = (name: string, score: number, at: number): TournamentEntry => ({ name, score, max: 50, passed: [], at })
  const list = standings({ "a/x": e("A", 10, 5), "a/y": e("A", 10, 9), "b/x": e("B", 20, 3), "c/x": e("C", 5, 1) })
  expect(list.map((s) => [s.name, s.total, s.place])).toEqual([["B", 20, 1], ["A", 20, 2], ["C", 5, 3]])
  expect(list[1].scores).toEqual({ x: 10, y: 10 })
})
it("records only a solution the student writes and a test they do not", () => {
  const meta = (id: string, extra: Partial<FileMeta> = {}): FileMeta => ({ id, kind: "text", size: 0, ...extra })
  const rules = (solution: Partial<FileMeta> = {}, test: Partial<FileMeta> = { hidden: true }): Rules => ({
    files: { "s/ivan/a.py": meta("a", solution), "s/a.test.py": meta("t", test) },
    folders: { "s/ivan": "ivan" },
    frozen: false,
    tournaments: {},
  })
  const ivan: Member = { level: "read", roles: ["ivan"] }
  expect(mayRecord(ivan, "s/ivan/a.py", "s/a.test.py", rules())).toBe(true)
  expect(mayRecord({ level: "write", roles: [] }, "s/ivan/a.py", "s/a.test.py", rules())).toBe(false) // чужая папка
  expect(mayRecord(ivan, "s/ivan/a.py", "s/a.test.py", rules({ protected: true }))).toBe(false)
  const insideOwnFolder: Rules = { ...rules(), files: { "s/ivan/a.py": meta("a"), "s/ivan/a.test.py": meta("t") } }
  expect(mayRecord(ivan, "s/ivan/a.py", "s/ivan/a.test.py", insideOwnFolder)).toBe(false) // может менять тест
})
```

В `access.test.ts`:
```ts
const withTournaments = rules({ tournaments: { open: { private: false }, closed: { private: true } } })
expect(docAccess(reader, "t:open", withTournaments)).toBe("read")
expect(docAccess(writer, "t:open", withTournaments)).toBe("read")
expect(docAccess(reader, "t:closed", withTournaments)).toBe("none")
expect(docAccess(reader, "t:unknown", withTournaments)).toBe("none")
expect(docAccess(admin, "t:closed", withTournaments)).toBe("write")
```
В фикстуру `rules` добавить `tournaments: {}`.

В `store.test.ts`: запись в `structure.tournaments` открывает документ `t:<id>`, удаление записи убирает его из `ids()`. В `files.test.ts`: `resetProject` и `replaceProject` очищают `tournamentsOf`.

- [ ] **Шаг 2: убедиться, что тесты падают**

Запуск: `cd /Users/lixelv/Documents/dev/python-coder/frontend && npx vitest run src/lib/tournament.test.ts src/lib/project`
Ожидается: FAIL.

- [ ] **Шаг 3: реализовать**

- Первое попадание записывается всегда, включая счёт 0, чтобы участник появился в таблице. Сравнение только строгое.
- Ключ `results` — `<userId>/<задача>`, разбирается по первому `/`.
- `Standing` при равной сумме сравнивается по максимальному `at`; если и он равен, порядок стабильный, а место всё равно следует индексу.
- `docAccess`: для `t:` неизвестный или закрытый турнир даёт `none`, иначе `read`. Администратор пишет — эта ветка уже есть в начале функции.
- `rulesOf` читает `tournaments`.
- `ProjectStore.follow`: `structure.tournaments` наблюдается как `files`; цикл удаления обрабатывает и `f:`, и `t:`.
- `replaceProject`: `tournamentsOf(s).clear()` в транзакции.
- Комментарий с перечнем документов в начале `store.ts` дополняется `t:<id>`.

- [ ] **Шаг 4: запустить проверки**

Ожидается: всё зелёное.

---

### Задача 6: запись результатов

**Файлы:**
- Изменить: `frontend/src/App.tsx:441-509`, `frontend/src/lib/collab/provider.ts:48`, `frontend/src/components/check-results.tsx` (только тип `CheckState`)

**Интерфейсы:**
- Потребляет: `CheckOutcome`, `entryOf`, `recordRun`, `mayRecord`, `taskOf`, `ensureTournament`.
- Даёт: `type CheckTournamentInfo = CheckTournament & { max: number }` в `lib/tournament.ts`; `CheckState` и сигнал `check-result` получают `tournament?: CheckTournamentInfo` и `unrecorded?: boolean`.

- [ ] **Шаг 1: расширить `checkHere` в `App.tsx`**

Функция возвращает `results`, `error`, `tournament` с `max` (сумма `points`) и `testFile`. `checkHere` выполняется только у администратора или без сессии, поэтому при турнирном результате всегда вызывает `ensureTournament`. Новая функция `recordCheck(check, path, userId, name, member: Member | null): boolean` возвращает значение `unrecorded`:
- без турнира, с ошибкой или с `entryOf(...) === null` ничего не пишет и возвращает `false`;
- если `member === null` (без сессии) или `mayRecord(member, path, testFile, rulesOf(store))`, вызывает `recordRun(store.doc("t:" + id), userId, taskOf(testFile), entry)` и возвращает `false`;
- иначе возвращает `true`.

- [ ] **Шаг 2: подключить два пути записи**

- `startCheck` без `provider`: `recordCheck` c `collab.me ?? "local"`, именем `nameFor(collab.me ?? "local")` и `member = null`.
- Обработчик сигнала `check`: `recordCheck` с `from.userId`, именем `collab.peers.find((p) => p.clientId === signal.from)?.user.name ?? nameFor(from.userId)` и `member = from`. Вызов идёт после проверки, поэтому правила уже свежие: роль могла измениться, пока проверка стояла в очереди. Сигнал `check-result` передаёт `tournament` и `unrecorded`.
- Собственная проверка администратора в сессии показывает результат и ничего не пишет.

- [ ] **Шаг 3: запустить проверки**

Ожидается: всё зелёное. Поведение проверяется в задаче 8.

---

### Задача 7: интерфейс

**Файлы:**
- Создать: `frontend/src/components/tournament-panel.tsx`, `frontend/src/hooks/use-tournaments.ts`
- Изменить: `frontend/src/components/check-results.tsx`, `frontend/src/App.tsx:376,511-516,1082`, `frontend/src/lib/i18n.ts`

**Интерфейсы:**
- Даёт: `useTournaments(store, access: AccessView): { id: string; private: boolean; tasks: string[]; standings: Standing[] }[]` — только турниры с `docAccess !== "none"`, обновляется по `structure` и по `update` каждого `t:<id>`.
- Даёт: `TournamentPanel({ tournaments, tabs, onClose })` в той же раскладке, что `CheckResults`.

- [ ] **Шаг 1: обновить `CheckResults`**

- Пропущенный тест: серый значок, текст `t("check.skipped")`, красной иконки нет.
- Стоимость теста справа рядом с замерами: `+10` у пройденного, серое `10` у остальных. Только если есть `tournament`.
- В заголовке при `tournament` вместо обычного итога `t("tournament.summary", { score, max })`.
- При `unrecorded` строка `t("tournament.unrecorded")` над списком.

- [ ] **Шаг 2: написать хук и панель**

Таблица: место, имя, колонка на задачу (`—`, если результата нет), сумма. Выбор турнира — кнопки вверху, если турниров больше одного; выбранный запоминается в `useState`. Пустая таблица показывает `t("tournament.empty")`. Рамка закрытого турнира подписана `t("tournament.private")` (её видят только администраторы).

- [ ] **Шаг 3: подключить вкладку в `App.tsx`**

`lowerTab` получает значение `"tournament"`; вкладка добавляется в `lowerTabList`, если `useTournaments` дал непустой список. В условии скрытия консоли учитывается новая вкладка. Если турниры исчезли, а вкладка выбрана, происходит переход на `console`.

- [ ] **Шаг 4: добавить строки в `i18n.ts`**

| Ключ | en | ru |
|---|---|---|
| `check.skipped` | `skipped` | `пропущен` |
| `tournament.tab` | `Tournament` | `Турнир` |
| `tournament.summary` | `{score} of {max} points` | `{score} из {max} баллов` |
| `tournament.unrecorded` | `Not added to the table: you can change the tests, or cannot change this solution.` | `В таблицу не записано: вы можете менять тесты или не можете менять это решение.` |
| `tournament.empty` | `No results yet.` | `Результатов пока нет.` |
| `tournament.private` | `Only teachers see this table` | `Эту таблицу видят только учителя` |
| `tournament.place` | `Place` | `Место` |
| `tournament.name` | `Name` | `Имя` |
| `tournament.total` | `Total` | `Сумма` |

- [ ] **Шаг 5: запустить проверки**

Ожидается: всё зелёное.

---

### Задача 8: проверка в браузере и документация

**Файлы:**
- Создать: скрипт в scratchpad (не в репозитории), `.../scratchpad/e2e/tournament.mjs`
- Изменить: `CLAUDE.md`, `docs/superpowers/specs/2026-10-31-tournaments-design.md` (статус)

- [ ] **Шаг 1: пересобрать контейнер**

Запуск из корня репозитория: `docker compose up -d --build frontend`
Ожидается: контейнер запущен, `http://localhost:8081` отвечает.

- [ ] **Шаг 2: написать сценарий puppeteer-core для реальной сессии: учитель и два ученика с ролями**

Заметки из `CLAUDE.md`: хук `polycode:e2e`, `/api/me` один раз до загрузки приложения. Проверяется:

1. Тест в родительской папке находится, а файл ближе имеет приоритет.
2. Баллы, `skipped`, итог «N из M»; лучший запуск сохраняется после худшего, `at` не меняется при равном счёте.
3. Таблица живьём у всех; при `private=True` документ у ученика не появляется, вкладки нет, результат на вкладке Tests есть.
4. Решение, которое через `sys.modules` и `gc` ищет `polycode_test` и подделывает результат, не получает баллов.
5. `random.py` в проекте не меняет `import random` в тесте.
6. Турнирная проверка C++.
7. Бесконечный цикл с `timeout=1` и без него; проверка завершается, следующий запуск снова работает.
8. `os.read(0, 10)` и `sys.stdin.read()` не блокируются.
9. 2 МБ многобайтового вывода дают `output limit exceeded`.
10. Ученик, который может писать в тест: `unrecorded`, таблица не меняется.
11. Обычные проверки Python и C++ работают как раньше; проверка без сессии пишет локальную таблицу.

- [ ] **Шаг 3: запустить сценарий и исправить найденное**

Ожидается: все пункты проходят, в консоли страницы нет ошибок.

- [ ] **Шаг 4: обновить `CLAUDE.md`**

- Таблица документов: `t:<id>` и `structure.tournaments`.
- Раздел **Automatic checks**: наследование, турнирный файл, `tournament_of`, `points`, `skipped`, отдельный воркер решения (`batch`), `BATCH_STARTED`, лимит 120 с.
- Заменить `_run_cpp`, `_run_wasm`, `polycode_run_wasm`, `run_wasm`, `kill_wasm` новыми именами.
- Раздел **Access**: `docAccess` для `t:`.
- Команда vitest: упоминание турниров.

- [ ] **Шаг 5: поставить в спецификации статус «реализовано» и запустить все проверки**

Запуск: команды из «Общих ограничений» и `cd /Users/lixelv/Documents/dev/python-coder/backend && go vet ./... && go test ./...`
Ожидается: всё зелёное. Backend не менялся, это проверка, что ничего не задето.
