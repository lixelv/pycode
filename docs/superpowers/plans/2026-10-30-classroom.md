# pycode: класс — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (Native, выбрано пользователем). Шаги — чекбоксы `- [ ]`.

**Цель:** реализовать спеку «класс»:
- роли и права на папки, защищённые и скрытые файлы, заморозка;
- имена, «Следовать», замена владельца;
- бинарные файлы и drag-and-drop;
- Markdown, PDF, PPTX, презентация;
- HTML/CSS/JS и Prettier;
- автопроверка и отладчик;
- доска.

**Архитектура:**
- Проект — набор Y.Doc: `structure`, `runtime`, `board`, `f:<id>`. Они
  синхронизируются по одной mesh-сети с `docId` в каждом сообщении.
- Права считает функция `access.ts` у каждого получателя.
- Сервер выдаёт коды и роли и выбирает `room.owner`.

**Стек:**
- React 19, Yjs, Monaco, Pyodide, Go 1.26 и Postgres;
- новое: vitest, `@excalidraw/excalidraw` 0.18, `pdfjs-dist`,
  `pptx-preview`, `prettier`, `htmlhint`.

**Спека:** `docs/superpowers/specs/2026-10-30-classroom-design.md`

## Global Constraints

- **Лимит проекта — 64 МБ:** `PROJECT_LIMIT = 64 * 1024 * 1024`
  (бинарные файлы, тексты и картинки доски).
- **Части бинарного файла — 1 МБ:** `BLOB_PART = 1024 * 1024`.
  Запрашиваются строго по одной, чтобы не переполнить очередь relay.
- **Зарезервированное имя:** `.pycode.env` в корне.
- **Формат строк `.pycode.env`:**
  - `role <name> <read|write>`
  - `folder <role> <path>`
  - `protected <path>`
  - `hidden <path>`
- **Уровни:** `read` < `write` < `admin`. Роль `owner` — это admin, плюс
  сброс проекта и завершение сессии.
- **Языки:** весь UI-текст через `t()`, ключи `en` и `ru` в `src/lib/i18n.ts`.
- **Проверка после каждой задачи:**
  - `cd frontend && npx tsc -b && npx oxlint src && npx vitest run`;
  - `cd backend && gofmt -l . && go vet ./... && go test ./...`;
  - `docker compose up -d --build`;
  - e2e в puppeteer-core против Chrome на `:8081`.
- **Коммиты:** один на задачу, сообщение заканчивается строкой
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Код:** проще — лучше, без лишних абстракций. Стиль как в соседнем
  коде.

## Review Focus

1. **Гость входит, когда в сети только ученики.** Документ `structure`
   принимается только от admin, поэтому дерево пустое. Нужна понятная
   подпись «Ждём учителя», а не вечная загрузка. Тест в задаче 4.
2. **Admin переименовывает папку с ролью.** Назначение роли в
   `structure.folders` должно переехать вместе с папкой, иначе
   содержимое станет публичным. Тест в задаче 2 (`renameRules`).
3. **Перетащили 70 МБ.** Ничего не добавляется, показывается toast.
   Повторная вставка того же файла не удваивает размер, потому что
   файлы адресуются по хешу. Тест в задаче 8.
4. **Владелец перезагрузил страницу посреди сессии.** Временный
   владелец отдаёт роль обратно, документы владельца догоняют изменения,
   двойного сброса нет. Тест в задаче 3 (Go) и e2e в задаче 4.
5. **Ученик открыл файл, к которому потерял доступ** (admin назначил
   папке чужую роль). Редактор закрывает файл, и правки по нему больше
   никуда не уходят. Тест в задаче 4.

---

## Этап 1. Модель проекта

### Задача 1: несколько документов, синхронизация с docId, миграция

**Файлы:**
- создать `frontend/src/lib/project/store.ts`;
- переписать `frontend/src/lib/project/project.ts` (функции получают
  `ProjectStore`) и `lib/collab/doc.ts` (`runtime`);
- `lib/collab/provider.ts` — мультиплекс по `docId`;
- `hooks/use-collab.ts`, `hooks/use-shared-console.ts`;
- `components/code-editor.tsx` (текст берётся из `f:<id>`),
  `components/file-tree.tsx`, `App.tsx`.

**Интерфейсы:**

```ts
export interface FileMeta { id: string; kind: "text" | "binary"; size: number; hash?: string; mime?: string; protected?: true; hidden?: true }
export class ProjectStore {
  constructor(persist: boolean)          // persist=true: y-indexeddb "pycode:<docId>"
  readonly ready: Promise<void>
  readonly structure: Y.Doc; readonly runtime: Y.Doc; readonly board: Y.Doc
  doc(docId: string): Y.Doc              // get-or-create; emits "doc"
  onDoc(fn: (docId: string, doc: Y.Doc) => void): () => void
  ids(): string[]
  destroy(): void
}
metasOf(s): Y.Map<FileMeta>; dirsOf(s); textOf(s, path): Y.Text | null   // doc("f:"+id).getText("t")
createFile(s, path, content?), createDir, deletePath, renamePath (меняет только ключи meta), replaceProject, resetProject, snapshotFiles(s): Record<string,string>
localStore(): ProjectStore               // заменяет localProject()
```

- `structure`: `files`, `dirs`, `packages`, `roles`, `folders`, `state`.
- `runtime`: `terminal`, `run`, `debug`.
- Провайдер: `new CollabProvider(session, me, store)`.
  - Сообщение: `[MSG_SYNC][varString docId][y-sync]`.
  - На `onDoc` и при готовности связи отправляется step1 по всем `ids()`.

**Шаги:**
- [ ] `localStore()` при пустом `structure` читает старую базу
  `python-coder:project` через `IndexeddbPersistence`, переносит файлы,
  папки и пакеты и удаляет базу через `clearData()`.
- [ ] Перевести всех потребителей. Поведение не меняется.
- [ ] e2e: один пользователь — правка, перезагрузка, файл на месте.
  Два браузера — правка видна, курсор виден.
- [ ] e2e со старой базой: скрипт сам пишет `python-coder:project` в
  старом формате через `y-indexeddb`, после перезагрузки проект
  перенесён.
- [ ] Коммит `Split the project into per-file documents`.

## Этап 2. Доступ

### Задача 2: `access.ts` и `.pycode.env` (чистые функции, vitest)

**Файлы:**
- создать `frontend/src/lib/project/access.ts` и `access.test.ts`;
- добавить `vitest` в devDependencies и скрипт `"test": "vitest run"`.

**Интерфейсы:**

```ts
export type Level = "read" | "write" | "admin"
export interface Member { role: string; level: Level }   // role: owner|admin|write|read|<custom>
export interface Rules { files: Record<string, FileMeta>; folders: Record<string, string>; frozen: boolean }
export function fileAccess(m: Member, path: string, r: Rules): "none" | "read" | "write"
export function docAccess(m: Member, docId: string, r: Rules): "none" | "read" | "write"  // structure: read|admin→write; runtime/board: level (frozen→read); f:<id> → fileAccess(path of id)
export function renameRules(folders: Record<string,string>, from: string, to: string): Record<string,string>
export function serializeEnv(x: EnvRules): string
export function parseEnv(text: string): EnvRules
export interface EnvRules { roles: Record<string, "read" | "write">; folders: Record<string, string>; protected: string[]; hidden: string[] }
export const RESERVED = ".pycode.env"
```

**Шаги:**
- [ ] Тесты:
  - admin пишет всё;
  - `hidden` → `none` для `write`;
  - `ivan` в `s/ivan/a.py` → `write`, `petr` → `none`;
  - вложенные `s` (роль `ivan`) и `s/x` (роль `petr`): `ivan` для
    `s/x/a.py` → `none`, а для `s/a.py` → `write`;
  - публичный `protected` для `write` → `read`;
  - `frozen` превращает `write` в `read`, admin не затрагивает;
  - `renameRules` переносит `s/ivan` → `t/ivan`;
  - `parseEnv(serializeEnv(x))` даёт `x`, пути с пробелами
    сохраняются.
- [ ] Реализация. Прогнать `npx vitest run`, должно быть PASS.
- [ ] Коммит `Access rules and .pycode.env`.

### Задача 3: сервер — коды ролей, уровни, замена владельца

**Файлы:**
- `backend/internal/db/schema.sql`: `sessions.ask_name bool not null default false`
  и `session_codes(code text pk, session_id uuid, role text, level text)`;
- `session/store.go`, `hub.go`, `room.go`, `protocol.go`;
- создать `session/room_test.go`.

**Интерфейсы:**
- `POST /api/sessions {askName, roles:[{name,level}]}` → `{session, codes:[{role,level,code}]}`.
  Всегда создаются коды `read`, `write`, `admin`.
- `GET /api/sessions/{code}` → `{session:{id,ownerId,askName,endedAt?}, role, level}`.
- `GET /api/sessions/{code}/codes` — только owner или admin.
- `POST /api/sessions/{code}/roles {name, level}` — только owner или
  admin онлайн. Возвращает `{role, level, code}`.
- WS `/api/sessions/{code}/ws`: роль берётся из кода, владелец по
  cookie всегда `owner`/`admin`.
  - `peerInfo{peer,userId,role,level}`;
  - `welcome` содержит `owner`;
  - сообщение `{"type":"owner","peer":N}` при смене владельца.
- `room.pickOwner()`: настоящий владелец онлайн, иначе admin, который
  вошёл раньше всех (наименьший `peer`), иначе 0.
- `reset` принимается только от `room.owner`.

**Шаги:**
- [ ] Go-тесты на `pickOwner`:
  - владелец онлайн;
  - владелец ушёл, admin `peer` 3 и 5 → 3;
  - владелец вернулся → снова он;
  - нет admin → 0.
- [ ] Go-тест: `reset` от не-owner → `error`.
- [ ] Реализация, `go test ./...` — PASS.
- [ ] Коммит `Per-role session codes and owner failover`.

### Задача 4: клиент — права в синхронизации, «Поделиться», меню дерева

**Файлы:**
- `provider.ts`: `member: Member`, `owner: number`, событие `owner`;
  `accessOf(link, docId)` проверяется на отправке и приёме;
  `REST createSession(askName, roles)`, `listCodes`, `addRole`;
- `hooks/use-collab.ts`;
- создать `hooks/use-access.ts`:
  `useAccess(store, member) → { level, frozen, can(path): "none"|"read"|"write", isAdmin }`;
- переписать `share-dialog.tsx`:
  - список ролей (ссылка, код, копировать);
  - «Добавить роль» (имя, уровень);
  - галочка «Спрашивать имя»;
- `file-tree.tsx`:
  - контекстное меню admin: «Защитить/Снять защиту», «Показать ученикам/Скрыть»
    (для `*.test.py`), «Доступ папки → роль / Публичная»;
  - иконки замка и глаза, бейдж роли;
  - недоступные файлы скрыты;
  - создание `.pycode.env` в корне запрещено;
- `project.ts`:
  - `exportZip` пишет `.pycode.env`, `importZip` применяет его;
  - `createFile` для `*.test.py` ставит `hidden`;
  - `renamePath` вызывает `renameRules`;
- `App.tsx`: `canWrite` → `access.can(active) === "write"`; пакеты,
  создание и удаление только у admin.

**Шаги:**
- [ ] e2e, три браузера (owner, `ivan`, `write`):
  - `ivan` не загружает `f:<id>` скрытого теста и папки `petr`
    (проверить `store.ids()` через `window.__store`, только в dev);
  - правка `write` в защищённом файле не доходит до owner;
  - owner ушёл, admin стал owner; owner вернулся, роль вернулась;
  - гость без admin в сети видит «Ждём учителя»;
  - папке ученика назначили чужую роль, открытый файл закрылся.
- [ ] Коммит `Roles, protected and hidden files, folder access`.

## Этап 3. Сессия

### Задача 5: имена и тумблер подписей курсоров

**Файлы:**
- создать `components/name-dialog.tsx`;
- `use-collab.ts`: перед `attach`, если `askName` и нет
  `localStorage["pycode:name:<code>"]`, ждём ввод. Последнее имя хранится
  в `pycode:name`;
- `remote-cursors.tsx`: подпись только при включённом
  `labels` (`localStorage "pycode:cursor-labels"`, по умолчанию `"0"`);
- кнопка-тумблер в футере `App.tsx` рядом с темой.

**Шаги:**
- [ ] e2e: имя спрашивается и попадает в список участников. Без
  галочки окна нет. Тумблер показывает и скрывает подписи.
- [ ] Коммит `Session names and cursor label toggle`.

### Задача 6: «Следовать»

**Файлы:**
- создать `components/follow-button.tsx`;
- `App.tsx` публикует `awareness.view = {tab, file, top}` (троттлинг
  100 мс) и применяет его к цели;
- `code-editor.tsx` получает `onScroll` и `scrollTo(top)`.

**Поведение:**
- Нажатие без слежения следует за `provider.owner`.
- Нажатие во время слежения открывает DropdownMenu: участники и
  «Перестать следовать».
- Ручное открытие файла или вкладки сбрасывает слежение.

**Шаги:**
- [ ] e2e: A следует за owner; owner открывает файл и скроллит — у A то
  же самое. Клик A по другому файлу снимает слежение.
- [ ] Коммит `Follow mode`.

### Задача 7: заморозка и анимация инея

**Файлы:**
- создать `components/frost-overlay.tsx` и CSS в `index.css`
  (`@keyframes frost-in/frost-out`, `feTurbulence`);
- кнопка со снежинкой у admin в шапке;
- `structure.state.frozen`.

**Шаги:**
- [ ] e2e: admin замораживает — у ученика редактор только для чтения,
  Run неактивен, на экране слой `.frost`. Размораживает — слой уходит.
- [ ] Коммит `Freeze mode with frost animation`.

## Этап 4. Файлы

### Задача 8: бинарные файлы

**Файлы:**
- создать `frontend/src/lib/project/blobs.ts`:
  - `putBlob(bytes): Promise<string /*sha256*/>`;
  - `getBlob(hash): Promise<Uint8Array | null>`;
  - `ensureBlob(hash): Promise<Uint8Array>` — через `provider.fetchBlob`;
  - IDB `pycode:blobs`;
- `provider.ts`: `MSG_BLOB_GET {hash, part}` / `MSG_BLOB_PART {hash, part, total, bytes | missing}`.
  Отдаём только при `access ≠ none`. Цель запроса: owner, затем
  остальные;
- `project.ts`:
  - `isText(name, bytes)`;
  - `addFiles(s, dir, entries: {path, bytes}[]): {added: string[]} | {error: "limit"}`;
  - `projectSize(s)`;
  - zip поддерживает бинарные файлы;
- runner получает бинарные файлы (`snapshotBinary`);
- создать `components/file-viewer.tsx`: картинка или карточка со
  скачиванием. Монтируется вместо редактора, если `kind === "binary"`.

**Шаги:**
- [ ] vitest:
  - `isText("a.py")` → `true`;
  - PNG-сигнатура → `false`;
  - `addFiles` сверх 64 МБ → `{error:"limit"}`;
  - тот же хеш повторно лимит не увеличивает.
- [ ] e2e: owner импортирует zip с PNG; у гостя картинка видна,
  `sha256` совпадает.
- [ ] Коммит `Binary files shared peer to peer`.

### Задача 9: перетаскивание

**Файлы:**
- создать `components/drop-zone.tsx`:
  - слушатели на `window`;
  - слой поверх панели файлов;
  - целевая папка по `data-path` строки под курсором;
- `file-tree.tsx`: атрибут `data-path`, подсветка новых строк на
  1,2 с.

**Шаги:**
- [ ] e2e (`DataTransfer` через `page.evaluate` и `dispatchEvent`):
  - сброс на папку `src` создаёт `src/a.png`;
  - не-admin слоя не видит.
- [ ] Коммит `Drag and drop files into the project`.

## Этап 5. Просмотр

### Задача 10: Markdown «Код | Рядом | Просмотр»

- Переключатель в `App.tsx` (`localStorage "pycode:md-mode"`, по
  умолчанию `split`).
- `markdown-preview.tsx` без кнопки закрытия, с blob-URL для картинок
  проекта.
- Run для `.md` убрать.
- [ ] e2e: в режиме «Рядом» текст в превью появляется после ввода.
- [ ] Коммит.

### Задача 11: PDF и PPTX

- Создать `components/pdf-view.tsx` (`pdfjs-dist`, воркер через `?url`)
  и `components/pptx-view.tsx` (`pptx-preview`).
- Общие пропсы: `{bytes, page?, onPages(n), onPage(n)}`.
- [ ] e2e: PDF из 2 страниц показывает счётчик `1 / 2`.
- [ ] Коммит.

### Задача 12: презентация

- `structure.state.presentation = {path, page, by}`.
- Создать `components/presentation.tsx`: полноэкранный слой. Ведущий
  листает стрелками, пробелом и кликом, Esc завершает.
- [ ] e2e: owner листает до страницы 2 — у гостя тоже страница 2;
  закрыть слой гость не может.
- [ ] Коммит.

## Этап 6. Веб

### Задача 13: языки HTML/CSS/JS, проверка, Prettier

- `monaco-core.ts`: подключить `language/html`, `css`, `typescript`
  (контрибуции и воркеры в `getWorker`).
- `languageOf` дополнить `html`, `css` и `javascript`.
- Создать `lib/htmlhint.ts`: маркеры, задержка 300 мс.
- Создать `lib/prettier.ts`: `formatWith(lang, code)`, плагины
  загружаются динамически.
- Кнопка Format работает для `html`, `css`, `javascript` и `markdown`.
- [ ] e2e:
  - `<div>` без закрывающего тега даёт ошибку в футере;
  - Format приводит `a{color:red}` к `a {\n  color: red;\n}\n`.
- [ ] Коммит.

### Задача 14: превью и запуск JS

- Создать `lib/web-preview.ts`: `buildPage(files, entry): string`.
  Ссылки `link`, `script`, `img` и `url()` заменяются на `data:`.
  Добавляется скрипт `console`/`error` → `postMessage`.
- Создать `components/web-preview.tsx`: `<iframe sandbox="allow-scripts allow-modals" srcdoc>`.
- В `App.tsx` Run для `.html` открывает превью (вкладка в области
  консоли), Run для `.js` запускает скрытый iframe.
- Вывод зеркалится через `appendTerminal`.
- [ ] vitest: `buildPage` инлайнит `style.css` и `app.js`, а
  `https://…` оставляет.
- [ ] e2e: `console.log("hi")` из `app.js` появляется в консоли.
- [ ] Коммит.

## Этап 7. Обучение

### Задача 15: автопроверка

- `python/checker.py`: `run_tests(solution_path, test_source) -> [{name, ok, message}]`
  и модуль `pycode_test.run(stdin)`.
- В `runner.worker.ts` режим `check`:
  - удалить `indexedDB`, `caches` и `fetch`;
  - тест не пишется в FS;
  - таймаут 30 с.
- `provider` сигналы `{type:"check", to, from, path}` и
  `{type:"check-result", to, results, error?}`.
- Проверяющий: owner, если он admin, иначе admin с наименьшим `peer`
  среди онлайн.
- Создать `components/check-results.tsx`.
- [ ] e2e: ученик с неверным решением видит 1 красный тест; исправил —
  всё зелёное.
- [ ] Коммит.

### Задача 16: отладчик

- `python/debugger.py`: подкласс `bdb.Bdb`, только файлы из
  `/home/pyodide/project`.
- Воркер шлёт `paused {file,line,stack,locals}` и ждёт команду через
  SAB (`continue|next|step|return|stop`).
- Создать `hooks/use-debugger.ts`.
- Точки останова в glyph margin (`localStorage "pycode:bp:<path>"`).
- Зеркалирование в `runtime.debug`.
- Создать `components/debug-panel.tsx`.
- [ ] e2e: точка останова на строке 2, «Отладка» — подсвечена строка
  2, видна `x = 1`; F10 — строка 3.
- [ ] Коммит.

## Этап 8. Доска

### Задача 17: Excalidraw

- Создать `components/board.tsx`:
  - lazy `@excalidraw/excalidraw`;
  - синхронизация с `store.board` (`elements` и `files`);
  - `collaborators` из awareness `boardPointer`;
  - `viewModeEnabled` при уровне `read` или заморозке.
- Ассеты копировать в `public/excalidraw/`, задать
  `window.EXCALIDRAW_ASSET_PATH`.
- Вкладка «Доска» между Code и Packages.
- [ ] e2e: A рисует прямоугольник — у B он появляется.
- [ ] Коммит.

### Задача 18: документация

- Обновить `CLAUDE.md`: модель документов, права, протокол, новые
  компоненты, gotchas.
- [ ] Коммит.
