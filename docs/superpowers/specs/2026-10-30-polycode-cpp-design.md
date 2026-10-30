# polycode: C++, лимиты тестов, переименование — спецификация

Дата: 2026-10-30. Статус: одобрен в чате, на ревью.

## Цель

pycode становится **polycode**, образовательной IDE в браузере для Python
и C++. Нужно:

1. вкладка Packages только там, где она имеет смысл;
2. лимиты времени и памяти в `run()` и вывод замеров по тестам;
3. `polycode_test.module`: функции и классы решения без запуска программы;
4. переименование всего, включая библиотеки;
5. C++: подсветка, линтер, запуск, синтаксическое дерево и блок-схема,
   языки проекта;
6. пакеты для C++;
7. проверка C++-решений Python-тестами.

Принципы прежние: сервер не трогаем (кроме имени), всё выполняется в
браузере, код как можно проще.

## Порядок

1. Переименование. Оно трогает всё, поэтому первым.
2. Packages по языку.
3. `polycode_test`: лимиты и `module`.
4. Пробный прототип C++ (spike), результаты записываются сюда.
5. C++: языки проекта, редактор, линтер, запуск, деревья.
6. Пакеты C++.
7. Проверка C++.

## 1. Переименование

- **Видимые имена.** Везде polycode: `<title>`, логотип, manifest,
  README, CLAUDE.md, `frontend/package.json`, имя docker compose,
  комментарии.
- **Go-модуль** → `github.com/lixelv/polycode`. Папку и репозиторий на
  GitHub не трогаем.
- **Python.** Пакет `pycoder` → `polycode` (`installSources`).
  `pycode_test` → `polycode_test`; `pycode_test` остаётся алиасом того же
  модуля, чтобы старые тесты работали.
- **Ключи хранилища.**
  - IndexedDB: `pycode:<docId>` → `polycode:<docId>`, `pycode:blobs` →
    `polycode:blobs`.
  - localStorage: все `pycode:*` → `polycode:*`.
  - Перенос делается один раз при старте, до открытия проекта
    (`migrateStorage()` в `lib/storage.ts`):
    - localStorage: копируем ключи, которых ещё нет под новым именем, и
      удаляем старые;
    - IndexedDB: для каждой базы `pycode:*` из `indexedDB.databases()`, если
      базы с новым именем нет, копируем все object store с записями, затем
      удаляем старую.
  - Старая миграция `python-coder:project` остаётся и пишет уже в новые
    имена.
- **Архивы.** Пишем `.polycode.env`. При импорте читаем `.polycode.env`,
  иначе `.pycode.env`. Оба имени зарезервированы в корне.
- **Сервер.**
  - Postgres: пользователь и база `polycode`, новый volume `polycode-db`.
    Старые серверные сессии теряются, они и так живут 24 ч.
  - Cookie `pc_uid` остаётся.
- **Service worker.** Кэш `polycode-v1`, старый удаляется сам (`activate`
  удаляет чужие кэши).
- **e2e-хук.** `window.__polycode`, флаг `polycode:e2e`.

## 2. Packages по языку

Вкладка Packages видна, когда открыт `.py`, а после этапа 6 ещё `.cpp`,
`.cc`, `.cxx`, `.h`, `.hpp`. Для Python показывается текущая панель, для
C++ панель C++-пакетов. Если открыть файл другого типа, пока выбрана эта
вкладка, вид возвращается на Code.

## 3. `polycode_test`

### 3.1 Лимиты

```python
run(stdin: str = "", timeout: float | None = None, ram_usage: float | None = None) -> str
```

**Параметры.**

- `timeout` в секундах, `ram_usage` в мегабайтах (10⁶ байт).
- `None` и `0` означают «выключено»: величина не измеряется и не
  показывается.

**Время** (только при `timeout`).

- `run()` вызывает JS-хук `polycode_deadline(ms)`: воркер шлёт странице
  `{type: "deadline", ms}`.
- `RunnerClient` ставит таймер. По срабатыванию он пишет 2 в
  interrupt-буфер, как это делает Stop. После `run()` хук вызывается с 0
  и таймер снимается.
- `KeyboardInterrupt` внутри `run()` превращается в
  `TimeLimitExceeded(TimeoutError)`.
- Если программа поймала прерывание и всё же завершилась, `run()` всё
  равно сравнивает прошедшее время с лимитом.
- Время меряется `time.perf_counter()` вокруг самой программы.

**Память** (только при `ram_usage`).

- Python: `tracemalloc.start()` перед запуском, пик из
  `get_traced_memory()` после, затем `tracemalloc.stop()`.
- C++: размер линейной памяти wasm после выполнения (`memory.buffer`,
  растёт только вверх, значит это пик).
- Превышение → `MemoryLimitExceeded(MemoryError)`. Проверяется после
  завершения программы.

**Исключения.** Оба класса лежат в `polycode_test` и хранят `used` и
`limit` как float. `_failure` выдаёт для них текст, собранный только из
чисел:

- `time limit 1 s exceeded: 1.43 s`;
- `memory limit 64 MB exceeded: 81.2 MB`.

Решение не может передать через них произвольный текст: `float()` от
полей, при ошибке просто имя типа.

**Замеры теста.**

- Перед каждым тестом счётчики обнуляются.
- `run()` с `timeout` прибавляет время к `time` теста.
- `run()` с `ram_usage` обновляет максимум `memory` теста в байтах.
- `CheckResult` получает необязательные `time?: number` (секунды) и
  `memory?: number` (байты).
- Вкладка Tests показывает их справа в строке теста (`0.12 s · 3.4 MB`),
  только если они есть.

### 3.2 `module`

`polycode_test.module` — модуль с объявлениями решения. Сама программа не
выполняется.

- **Сборка.** При первом обращении к атрибуту `module` (`__getattr__`
  модуля `polycode_test`) решение парсится через `ast.parse`.
- **Что остаётся** — только верхний уровень:
  - `Import`, `ImportFrom`;
  - `FunctionDef`, `AsyncFunctionDef`, `ClassDef`;
  - `Assign` и `AnnAssign`, если в правой части нет `ast.Call`
    (константы вроде `EPS = 1e-9`, `DIRS = [(0, 1)]`).
  - Всё остальное, включая `if __name__ == "__main__"`, `input()` и
    `print()`, отбрасывается.
- **Выполнение.** Остаток компилируется с именем файла решения и
  выполняется в новом `types.ModuleType` с именем по файлу решения. Модуль
  кэшируется на одну проверку.
- **Ошибки.**
  - Если решение — C++, при обращении бросается
    `TypeError("module is only for Python solutions")`.
  - Синтаксическая ошибка решения приходит как `SyntaxError`, и тест
    падает с именем типа.

## 4. Spike

Перед этапом 5 отдельный прототип в браузере с COOP/COEP (результаты
записываются сюда):

1. `@yowasp/clang` в воркере компилирует `#include <iostream>` и
   `std::cin`.
   - Время первой загрузки, время компиляции, работают ли исключения.
   - Это определяет флаги: при необходимости `-fno-exceptions`.
2. `@bjorn3/browser_wasi_shim` запускает результат.
   - `fd_read` блокируется на SharedArrayBuffer.
   - Файлы проекта видны через preopen `/project`.
3. В Pyodide есть `tracemalloc`.
4. Воркер может создать вложенный воркер, синхронно ждать его через
   `Atomics.wait(…, timeout)` и после таймаута `terminate()`.
   - Проверить в Chrome и Safari (WebKit из Playwright).
   - Fallback, если нельзя: wasm выполняется прямо в воркере проверки, и
     бесконечный цикл останавливает только общий лимит проверки 30 с.

Код прототипа выбрасывается.

### Результаты spike

Проверено 2026-10-30 в Chrome (headless, puppeteer-core) и WebKit
(Playwright 1.64), на `vite dev` и на `vite build` + `vite preview` с
COOP/COEP и CSP приложения. Подробности и рабочие куски кода:
`.superpowers/sdd/2026-10-30-polycode-cpp/task-6-report.md`.

**Версии.** `@yowasp/clang` 22.0.0-git20542-10 (clang 22, sysroot
`wasm32-wasip1`), `@bjorn3/browser_wasi_shim` 0.4.2, Vite 8, Pyodide
314.0.7 (Python 3.14.2).

**Размер.** 105 МБ без сжатия: `llvm.core.wasm` 75.5 МБ (gzip 23 МБ),
`llvm-resources.tar` 29.7 МБ (gzip 4.3 МБ), мелкие `llvm.core2..4.wasm`,
`bundle.js` 250 КБ. При gzip по сети ≈ 27 МБ.

**Время** (localhost, M-серия; сеть добавит скачивание 27 МБ):

- загрузка и компиляция модулей (`runClang(null)`): 0.3–1.0 с, из
  HTTP-кэша 0.3–0.6 с;
- первая компиляция программы с `<iostream>` (`-O1`): 1.3–2.6 с, дальше
  0.9–1.5 с; `-fsyntax-only` с `<iostream>` 0.75–1.9 с; программа без
  заголовков 35–80 мс;
- запуск wasm: компиляция модуля 1–17 мс, сама программа единицы мс.

**`runClang` в одном воркере** вызывается сколько угодно раз (проверено
10 подряд). Ресурсы скачиваются один раз на экземпляр `Application`;
каждый вызов создаёт новый экземпляр wasm. Предзагрузка —
`await runClang(null)`. Файлы — дерево `{"project": {"main.cpp": "…"}}`,
пути абсолютные (`/project/main.cpp`), результат — `out["a.out"]`
(`Uint8Array`, нужен `decodeASCII: false`). Ошибка компиляции — `Exit`
с `code`, диагностика приходит в `options.stderr` (ANSI-цвета нет и без
`-fno-color-diagnostics`).

**Как Vite отдаёт ресурсы.** `bundle.js` берёт их через
`new URL("./llvm.core.wasm", import.meta.url)`:

- dev: обязательно `optimizeDeps: { exclude: ["@yowasp/clang"] }`, иначе
  пребандл переносит `bundle.js` в `.vite/deps` и URL ломаются;
- build: Vite сам кладёт `.wasm` и `.tar` в `assets/` с хешами, если
  воркер — `new Worker(new URL("./cpp.worker.ts", import.meta.url),
  {type: "module"})` (или `?worker`), `worker.format: "es"` уже есть;
- `llvm.core4.wasm` (787 байт) Vite встраивает как `data:` URL, а CSP
  приложения (`connect-src` без `data:`) запрещает его `fetch` — clang не
  стартует. Нужен `build.assetsInlineLimit: (f) => /\.(wasm|tar)$/.test(f)
  ? false : undefined`;
- предупреждение «`node:fs/promises` externalized» безвредно;
- nginx: добавить `application/x-tar` в `gzip_types` (`.wasm` уже есть);
  на прод лучше заранее сжатые файлы (`gzip_static`), 75 МБ жать на
  лету дорого. Service worker уже кэширует `/assets/`.

**Исключения не работают.** В sysroot нет libunwind и libc++abi с
поддержкой исключений: `throw` даёт ошибку линковки
`undefined symbol: __cxa_allocate_exception / __cxa_throw` с любыми
флагами (`-fexceptions`, `-fwasm-exceptions`). Без
`-fwasm-exceptions` блоки `catch` просто выбрасываются компилятором.

Выбрано: флаги без `-fno-exceptions`, к каждой программе линкуется
маленький `stub.o` (компилируется один раз при старте воркера, 0.3–0.8 с)
с собственными `__cxa_allocate_exception`, `__cxa_free_exception`,
`__cxa_throw`. `throw` печатает в stderr `terminate called after throwing
an instance of 'std::runtime_error'` и `what():  …` (как g++), затем
`abort()` → ловушка `unreachable`, код выхода 134. `try/catch`
компилируется, но не ловит. С `-fno-exceptions` код с `try`/`throw` не
компилировался бы вовсе. В справке написать: «исключения завершают
программу». Тот же `stub.o` содержит конструктор, который делает
`chdir(getenv("POLYCODE_CWD"))`: так cwd — папка entry.

**WASI-шим.**

- Блокирующий stdin через свой `Fd` на `RunnerBuffers` работает в обоих
  браузерах: `cin` сбрасывает `cout` перед чтением, поэтому подсказка
  выводится до `input_request`. EOF — `fd_read` возвращает пустые данные.
- Preopen `/project` работает: `ifstream` читает относительные пути от
  cwd, абсолютные `/project/…`, `../…`; запись `ofstream` тоже.
- `memory.buffer.byteLength` после выхода: 128 КБ для пустой программы,
  50 МБ для `vector<char>(50'000'000)` — годится для `ram_usage`.
- Ловушка wasm приходит как исключение из `wasi.start()` (Chrome:
  `unreachable`, WebKit: `Unreachable code should not be executed`).

**`tracemalloc`** в Pyodide 314.0.7 есть: `start()`,
`get_traced_memory()` и `stop()` работают.

**Вложенный воркер не годится.** Ни в Chrome, ни в WebKit вложенный
воркер, созданный внутри синхронного участка, не стартует, пока родитель
стоит в `Atomics.wait`: каждый запуск упирается в таймаут. Заранее
созданный воркер в Chrome тоже не получает сообщение от заблокированного
родителя; в WebKit получает, но только первое (новый после `terminate()`
уже не стартует).

**Выбранный путь проверки — через страницу** (ни вложенный воркер, ни
fallback из пункта 4):

1. хук `polycode_run_wasm` в воркере проверки создаёт
   `SharedArrayBuffer` для результата и шлёт странице
   `{type: "run_wasm", wasm, stdin, result}`, затем `Atomics.wait` с
   таймаутом;
2. `RunnerClient` на странице создаёт `cpp-run.worker` в режиме `batch` и
   передаёт ему сообщение; тот пишет вывод, `memory` и код выхода в SAB и
   делает `Atomics.notify`;
3. после ожидания (успех или таймаут) хук шлёт `{type: "kill_wasm"}`,
   страница делает `terminate()`.

`postMessage` из заблокированного воркера доходит, страница свободна.
Работает в Chrome и WebKit: запуск 5–20 мс, бесконечный цикл
обрывается ровно по таймауту, следующий запуск идёт сразу. Значит,
`timeout` у C++ работает на каждый `run()`.

**Другие подводные камни.**

- `new WASI(args, env, fds)` без опций включает отладочный лог на каждый
  вызов — передавать `{debug: false}`.
- Vite (dev и preview) не ставит `server.headers` на ответы 304; WebKit
  тогда отказывается грузить воркер из кэша («Refused to load … because
  of Cross-Origin-Embedder-Policy»). Лечится middleware-плагином, который
  ставит COOP/COEP на каждый ответ. nginx ставит их и на 304.
- `poll_oneoff` (sleep) в шиме — активное ожидание, допустимо.

## 5. C++

### 5.1 Языки проекта

- **Хранение.** `structure.state.languages: ("python" | "cpp")[]`.
  Синхронизируется в сессии как остальная структура и пишется только
  админами.
- **Вычисление.** `languagesOf(store)` читает поле. Если поля нет (старый
  проект), язык выводится из файлов: есть `.py` → python, есть
  C++-расширение → cpp, пусто → python.
- **Добавление языка.** Создание файла, загрузка, перетаскивание и
  открытие архива с `.py` или C++-файлами добавляют язык
  (`addLanguagesFor(store, paths)` внутри тех же транзакций). Удаление
  файла язык не убирает.
- **Выбор языка для нового проекта.** Владельцу с пустым новым проектом
  (первый заход без проекта, «Новый проект») показывается диалог
  `LanguageDialog` с двумя карточками, Python и C++.
  - Выбор пишет `languages` и создаёт `main.py` или `main.cpp` (шаблон
    «Hello» с вводом).
  - Гость сессии диалог не видит.
  - Если закрыть диалог, остаётся Python.
- **Загрузка рантаймов.** Pyodide (runner, tools, Ruff) поднимается, только
  если в проекте есть python. Clang-воркер поднимается, только если есть
  cpp, лениво при первом линте или запуске. Добавился язык → недостающее
  подгружается.

### 5.2 Редактор и линтер

- **Подсветка.** Monarch-грамматика `cpp` из
  `monaco-editor/esm/vs/basic-languages/cpp/cpp` для `.cpp .cc .cxx .h .hpp`
  (`languageOf` → `"cpp"`).
- **Линтер.**
  - `clang++ -fsyntax-only -std=c++20 -fno-color-diagnostics` в
    `cpp.worker.ts` через 500 мс после правок.
  - Файлы проекта (`runVisible`) и пакеты лежат в виртуальной FS clang.
  - Вывод `file:line:col: (error|warning|note): message` разбирается
    `parseClangDiagnostics()` в маркеры Monaco открытого файла. `note`
    отбрасываются.
  - Ошибки в других файлах показываются у строки `#include`, который их
    тянет. Это делает сам clang (`In file included from`), берём первую
    строку цепочки.
- **Без форматирования, автодополнения и отладчика.** Кнопки Format,
  Debug и подсказки для C++ выключены.

### 5.3 Сборка и запуск

- **Компиляция** — `cpp.worker.ts`, функция `compile(files, entry,
  includes)`:
  - команда `clang++ -std=c++20 -O1 entry -o a.out`;
  - флаги `-I` для папки entry, корня проекта и include-путей пакетов;
  - `-Wl,--max-memory=1073741824` (1 ГБ);
  - результат: байты wasm или диагностика;
  - компилируется только открытый файл, остальное доступно через
    `#include`.
- **Запуск** — `cpp-run.worker.ts`:
  - WASI preview1 через `@bjorn3/browser_wasi_shim`;
  - stdin: `fd_read` блокируется на тех же `RunnerBuffers`, что
    `input()`, с тем же протоколом `input_request`, `STDIN_*`;
  - stdout и stderr идут событиями `stdout`/`stderr` (декодер UTF-8 со
    `stream: true`);
  - файлы проекта лежат в preopen `/project`, cwd — папка entry;
  - лимит вывода тот же, что у Python;
  - события и `exit` повторяют `RunnerEvent`.
- **Клиент.** `CppRunnerClient` — интерфейс `RunnerClient` для `run`:
  события, `sendStdin`, `sendEof`, `stop`.
  - Stop и лимит 120 с делают `terminate()` воркера и создают новый.
    Программа на wasm синхронна, прервать её иначе нельзя.
- **App.**
  - `runnable` включает `cpp`.
  - Запуск: статус «Компиляция…» → ошибки компиляции идут в stderr консоли
    и `exit` с кодом 1 → иначе запуск.
  - Зеркалирование в сессии, stdin от других и Stop работают без
    изменений.
- **Безопасность.**
  - Программа wasm видит только импорты WASI-шима: сети нет.
  - Воркеры C++ не имеют своего кода, который ходит на наш сайт.
  - Файлы — только `runVisible(entry)`.

### 5.4 Синтаксическое дерево и блок-схема

- **Парсер.** `web-tree-sitter` + `tree-sitter-cpp.wasm`, лениво, на
  странице (`lib/cpp/parse.ts`). Файлы wasm кладёт
  `scripts/copy-tree-sitter.mjs` в `public/tree-sitter/` (в gitignore).
- **Дерево** (`cppTree(code) → AstResponse`):
  - Именованные узлы tree-sitter, `type` — тип узла.
  - Листья с текстом (идентификаторы, литералы) — поле `value`.
  - Подписи рёбер — имена полей грамматики (`declarator`, `body`…), иначе
    пусто.
  - Тот же `MAX_NODES = 1500`.
  - Синтаксическая ошибка: первый узел `ERROR`/`MISSING` → `{ok: false,
    error: {message, line}}`.
- **Категории.** `categorize(type, lang)` для cpp:
  - `translation_unit` → module;
  - `*_definition`, `*_declaration`, `*_declarator`, `parameter_list` →
    definition;
  - `*_literal`, `initializer_list` → literal;
  - `*_expression`, `identifier`, `field_identifier`,
    `qualified_identifier` → expression;
  - `*_statement` → statement;
  - иначе other.
- **Блок-схема** (`cppFlow(code, lang) → FlowResponse`), тот же формат, что
  у `flow.py`:
  - `function_definition` → группа `function`, внутри Start/End;
  - `class_specifier`, `struct_specifier` → группа `class`, методы — группы
    `method`;
  - `if_statement` → `decision` с ветками yes/no;
  - `switch_statement` → цепочка `decision` по `case`;
  - `for_statement`, `for_range_loop`, `while_statement`, `do_statement` →
    `loop` с ребром repeat;
  - `return_statement` → `return`; `break_statement`, `continue_statement`
    → `jump`;
  - `try_statement` → `try`, `catch_clause` → `except`;
  - выражения с `cin`/`cout`/`cerr`/`printf`/`scanf`/`puts`/`getline` →
    `io`;
  - объявления → `statement`;
  - рёбра `call` от узла к группе вызываемой функции из того же файла (по
    имени);
  - подписи (caption) en/ru по виду узла: «Условие: …», «Цикл: …», «Вывод»…;
  - точкой входа считается `main`.
- **AstDialog** выбирает `cppTree`/`cppFlow` для C++ и Python-воркер для
  `.py`. Кнопка «Дерево» активна для обоих языков.

## 6. Пакеты C++

- **Запись.** `owner/repo` или `owner/repo@ref`, проверяется регуляркой.
  `CppPackage {spec, repo, ref, version?, include?, status, error?}`.
  Хранится в `structure.cppPackages` (Y.Array), меняют админы.
- **Установка** (`lib/cpp/packages.ts`, на странице):
  1. Версия: `ref` или
     `https://data.jsdelivr.com/v1/packages/gh/<repo>/resolved`.
     Результат фиксируется в `version`.
  2. Файлы: `https://data.jsdelivr.com/v1/packages/gh/<repo>@<version>?structure=flat`.
  3. Include-путь: `include/`, если такая папка есть, иначе
     `single_include/`, иначе корень (`pickInclude(paths)`).
  4. Берутся файлы внутри include-пути: с расширением
     `.h .hpp .hh .hxx .ipp .inl .tpp`, а также без расширения (Eigen).
     Не больше 2000 файлов и 32 МБ.
  5. Файлы скачиваются с `https://cdn.jsdelivr.net/gh/<repo>@<version>/<path>`
     по 8 параллельно и передаются в clang-воркер как
     `/packages/<repo>/…`. Флаг `-I/packages/<repo>/<include>`.
- **Кэш.** Service worker кэширует `cdn.jsdelivr.net/gh/…@<version>` (только
  с конкретной версией) и `data.jsdelivr.com/…@<version>` по принципу
  cache-first.
- **Панель.** `CppPackagesPanel`: поле `owner/repo@tag`, список со
  статусами и Retry. Это повтор Python-панели без «встроенных» пакетов.
- **Перед линтом и запуском** незагруженные пакеты подгружаются сами.

## 7. Проверка C++

- **Кнопка «Проверить».** Есть у `name.cpp` (и других C++-расширений), если
  есть `name.test.py`. `testPath` — замена расширения решения на `.test.py`.
- **`checkHere` для C++** (в браузере админа):
  1. Clang-воркер компилирует решение. Ошибка компиляции становится
     ошибкой проверки «Compilation failed» и первыми строками диагностики.
     Это код самого ученика, утечки нет.
  2. `RunnerClient.check(files, solution, test, specs, wasm)` передаёт
     байты wasm в воркер проверки.
  3. В `checker.py` решение-C++ запускается в `run()` через JS-хук
     `polycode_run_wasm(stdin, timeoutMs) → {stdout, memory, timedOut}`,
     синхронно.
- **Хук `polycode_run_wasm`** (в `runner.worker.ts`, только для проверок):
  1. Создаёт вложенный воркер `cpp-run.worker.ts` в режиме `batch`: stdin
     целиком, без SAB-ввода, EOF в конце.
  2. Ждёт `Atomics.wait` на своём SAB с таймаутом: `timeoutMs` или
     остаток 30 с проверки.
  3. При таймауте делает `terminate()` и возвращает `timedOut`.
  4. Вывод приходит через SharedArrayBuffer (до лимита вывода).
  5. Если spike покажет, что так нельзя, используется fallback из раздела 4.
- **Вывод C++.** Подсказки ввода остаются частью вывода (`cout` перед
  `cin`). Это отмечается в справке по тестам.
- **Лимиты.** `timeout` и `ram_usage` работают так же: время меряется
  вокруг хука, память — это `memory` из хука.

## 8. Тестирование

- **vitest:**
  - `migrateStorage` (fake-indexeddb, если уже есть; иначе только
    localStorage-часть);
  - `languagesOf` / `addLanguagesFor`;
  - `parseClangDiagnostics`;
  - `pickInclude` и фильтр заголовков;
  - `cppTree`, `cppFlow` на нескольких программах (web-tree-sitter в node);
  - чтение `.pycode.env` и `.polycode.env`.
- **Python** (scratchpad pytest):
  - `module`: функции, константы, без `input()`, ошибка для C++;
  - лимиты с фейковыми хуками: превышение времени и памяти, тексты
    сообщений, замеры в результатах;
  - алиас `pycode_test`.
- **e2e в Chrome:**
  - переименование: старый проект под `pycode:*` открывается после
    обновления;
  - Packages видна только для `.py`;
  - лимиты на треугольнике (`timeout=1` на `while True`), замеры видны;
  - `module.triangulate`;
  - выбор языка на новом проекте;
  - C++ Hello с `cin`, Stop на бесконечном цикле, линтер-маркер;
  - дерево и блок-схема C++;
  - `nlohmann/json`;
  - проверка `main.cpp` тем же `main.test.py`;
  - в сессии: гость получает cpp и подгружает clang.

## Вне задачи

- Отладчик, автодополнение (clangd) и форматирование (clang-format) для
  C++.
- Несколько единиц трансляции: компилируется только открытый файл.
- `module` для C++.
- Лимиты для вызовов функций из `module` (только для `run()`).
