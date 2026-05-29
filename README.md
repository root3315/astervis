# astervis tools

Набор инструментов для **реконструкции** платформы Astervis из собранных Docker-образов: единый Bun-бандл (backend) и Turbopack-сборка Next.js (admin) разбираются на исходные модули, классифицируются, форматируются `prettier` и документируются.

> Astervis — аналитическая платформа для колл-центров на базе Asterisk/FreePBX.
> Бэкенд: Bun 1.3 + Elysia.js, ORM Drizzle поверх TimescaleDB (PostgreSQL 16 + pgvector),
> очереди BullMQ/Redis, репликация через Debezium/Kafka, AI-пайплайн обработки записей звонков.

## Установка

```bash
npm install
```

Зависимости: [`acorn`](https://github.com/acornjs/acorn) (парсер AST) + [`prettier`](https://prettier.io) (форматирование). Требуется Node.js с поддержкой ES-модулей.

## Конвейер (backend bundle)

Все скрипты читают «чистый» JS: бинарный трейлер Bun-бандла отрезается по первому NUL-байту. Запускаются по порядку:

| Шаг | Скрипт | Что делает |
|-----|--------|-----------|
| 1 | `probe.mjs <clean.js>` | Быстрая разведка: парсит AST, печатает статистику по top-level. |
| 2 | `toplevel.mjs <clean.js>` | Перечисляет top-level единицы и обёртки модулей (`__esm` / `__commonJS`). |
| 3 | `analyze.mjs <clean.js> <out.json>` | Строит манифест всех единиц с эвристическим скорингом «app vs vendor». |
| 4 | `index.mjs <clean.js> <outDir>` | Извлекает каждую единицу с байтовыми смещениями; пишет `vendor/modules/*`, `_payload.js`, `MANIFEST.json`. |
| 5 | `split.mjs <clean.js> <outDir>` | Разбивает бандл на отдельные файлы модулей и форматирует их. |
| 6 | `organize.mjs <outDir>` | Строит дерево `app/<категория>/` из манифеста (детерминированная категоризация: routes, services, db, integrations, ai, licensing, …). |
| 7 | `vendor_inlined.mjs <outDir>` | Сохраняет остаточные inline-vendor единицы — чтобы разбиение было **lossless**. |
| 8 | `verify.mjs <appDir>` | Проверка целостности: каждый `app/*.js` начинается с `/**`-заголовка и парсится без ошибок. |

### Эвристика app vs vendor

`index.mjs` / `analyze.mjs` присваивают каждой единице score по сигналам:
- **+** к app: `new Elysia(...)`, имена `*Controller` / `*Service` / `*Repository`, обработчики `processX`, worker-`main`, schema-модули с доменными словами (`cdr`, `bitrix24`, `asterisk`, `operator`, `pgvector`, `telegram` и т.д.), наличие HTTP-роутов.
- **−** к vendor: внутренности Drizzle/TypeBox, Lua-вставки, известные vendor-классы (`Packr`, `Queue`, `Redis`, `Elysia`, `DateTime`, …).

## Документирование

`doctasks.mjs` собирает сгруппированный список задач документирования из `reconstructed/<bundle>/APP_INDEX.json` (бандлы: `backend`, `queue`, `replication`, `sync_schedules`) → `doctasks.json`.

`document.workflow.js` — воркфлоу-оркестратор (для `Workflow`-tool): по `doctasks.json` параллельно добавляет RU-JSDoc-заголовки к каждому app-файлу (логику кода не трогает, только префикс), пишет README по категориям и синтезирует `DB-SCHEMA.md`, `ARCHITECTURE.md`, `README.md` каталога `reconstructed/`.

## admin/ — реконструкция Next.js фронта

Тот же подход для Turbopack-сборки админки (`.next`):
- `extract.mjs` — извлекает модули из таблиц Turbopack (два формата).
- `organize.mjs` — декодирует исходные пути из имён SSR-чанков, классифицирует vendor/app, строит `ID_MAP` и разводку роутов.
- `charts-worklist.mjs` — разрешает висящие импорты `@/components/charts/...` к SSR-модулям.
- `review-batches.mjs` — группирует файлы в батчи для ревью (пропуская стандартный shadcn ui).
- `fix-imports.mjs`, `verify-imports.mjs`, `verify-exports.mjs`, `verify-vendor-exports.mjs`, `syntax-check.mjs`, `use-client-check.mjs` — починка и верификация импортов/экспортов.

## smoketest/

Изолированный смоук-тест реконструированного backend-бандла: отдельная docker-сеть, эфемерные TimescaleDB + Redis, приложение на порту `15555`. **Не трогает** живой `astervis-*` стек.

```bash
docker compose -p astervis-smoke up --build
docker compose -p astervis-smoke down -v   # снести
```

## Замечания

- Имена вроде `drizzle2`, `import_dayjs3`, `status2`, `ctx` — артефакты минификации; они **не** переименовываются, только документируются.
- Vendor-модули разбиты, но не модифицированы.
- Конвейер детерминированный — повторный прогон на том же бандле даёт тот же результат.
