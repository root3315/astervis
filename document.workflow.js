export const meta = {
  name: 'astervis-document',
  description: 'Document reconstructed Astervis app modules + synthesize DB/architecture/navigation docs',
  phases: [
    { title: 'Load', detail: 'read the doc-task list' },
    { title: 'Document', detail: 'prepend RU doc headers to each app file group + write category READMEs' },
    { title: 'Synthesize', detail: 'DB schema, architecture, navigation docs' },
  ],
};

const TASK_SCHEMA = {
  type: 'object',
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'bundle', 'category', 'title', 'readmeDir', 'writeReadme', 'files'],
        properties: {
          id: { type: 'string' }, bundle: { type: 'string' }, category: { type: 'string' },
          title: { type: 'string' }, readmeDir: { type: 'string' }, writeReadme: { type: 'boolean' },
          files: { type: 'array', items: { type: 'object', required: ['path', 'name'],
            properties: { path: { type: 'string' }, name: { type: 'string' }, bytes: { type: 'number' }, routeCount: { type: 'number' } } } },
        },
      },
    },
  },
};

const DOC_RESULT = {
  type: 'object', required: ['category', 'files'],
  properties: {
    category: { type: 'string' },
    files: { type: 'array', items: { type: 'object', required: ['name', 'summary'],
      properties: { name: { type: 'string' }, summary: { type: 'string' } } } },
    notes: { type: 'string' },
  },
};

const CONTEXT = `Astervis — это аналитическая платформа для call-центров на базе Asterisk/FreePBX.
Бэкенд: Bun 1.3 + Elysia.js, ORM Drizzle поверх TimescaleDB (PostgreSQL 16 + pgvector). Очереди BullMQ/Redis.
Репликация через Debezium/Kafka. AI-пайплайн обрабатывает записи звонков (recording -> STT -> анализ).
Эти файлы РЕКОНСТРУИРОВАНЫ из Docker-образов: единый Bun-бандл распарсен, разбит на модули и отформатирован prettier.
Имена вроде drizzle2, import_dayjs3, status2, ctx — артефакты минификации. НЕ переименовывай их, только документируй.`;

phase('Load');
const loaded = await agent(
  `Прочитай файл tools/doctasks.json (он в текущей рабочей директории) и верни его содержимое как структуру {tasks:[...]} ВЕРБАТИМ (это валидный JSON-массив задач документирования).`,
  { label: 'load-doctasks', phase: 'Load', schema: TASK_SCHEMA }
);
const tasks = loaded?.tasks || [];
log(`Загружено ${tasks.length} задач документирования, файлов: ${tasks.reduce((s, t) => s + t.files.length, 0)}`);

phase('Document');
const docResults = await parallel(tasks.map((t) => () => {
  const fileLines = t.files.map((f) => `  - ${f.path}${f.routeCount ? `  (Elysia-контроллер, ~${f.routeCount} эндпоинтов)` : ''}`).join('\n');
  const readmeInstr = t.writeReadme
    ? `\n\nДОПОЛНИТЕЛЬНО: создай файл ${t.readmeDir}/README.md — краткий обзор (RU) этой группы модулей "${t.category}": её роль в системе и маркированный список файлов с однострочными описаниями.`
    : '';
  return agent(
    `${CONTEXT}\n\nТы документируешь группу "${t.title}" (сервис: ${t.bundle}, категория: ${t.category}).\n\nФайлы:\n${fileLines}\n\nДля КАЖДОГО файла:\n1. Прочитай его (Read).\n2. Добавь В НАЧАЛО файла JSDoc-комментарий на РУССКОМ языке через Edit: возьми первую непустую строку файла как old_string и сделай new_string = «блок-комментарий + перенос строки + та же первая строка». Блок-комментарий формата:\n   /**\n    * @module <имя>\n    * <одно предложение: назначение>\n    *\n    * <2-4 строки: что делает, ключевая логика>\n    * <для контроллеров: список эндпоинтов «METHOD /path — описание»>\n    * Зависимости: <таблицы drizzle / сервисы / внешние API, на которые ссылается код>\n    */\n3. КОД НИЖЕ НЕ МЕНЯЙ — ни строчки логики, только добавь заголовок сверху.${readmeInstr}\n\nВерни JSON: {category, files:[{name, summary}], notes}. summary — одно предложение про файл.`,
    { label: t.title, phase: 'Document', schema: DOC_RESULT, model: 'sonnet', agentType: 'general-purpose' }
  );
}));
const ok = docResults.filter(Boolean);
log(`Задокументировано групп: ${ok.length}/${tasks.length}`);

phase('Synthesize');
const summaryForArch = ok.map((r) => `### ${r.category}\n${(r.files || []).map((f) => `- ${f.name}: ${f.summary}`).join('\n')}`).join('\n\n').slice(0, 60000);

const [dbDoc, archDoc, navDoc] = await parallel([
  () => agent(
    `${CONTEXT}\n\nЗАДАЧА: создай файл reconstructed/DB-SCHEMA.md (на русском) — полную документацию модели данных.\nИсточники (прочитай их):\n- reconstructed/backend/app/db/schema.js (основная схема Drizzle, ~84KB) и schema__2.js если есть\n- migrate/drizzle/schema.ts (оригинальная TypeScript-схема — эталон имён) и несколько migrate/drizzle/migrations/*.sql\nОпиши ВСЕ таблицы, сгруппированные по доменам (звонки/CDR, операторы и роли, очереди openlines, сессии и сообщения, QA/оценка качества, AI/транскрипты/эмбеддинги, интеграции Bitrix24/AmoCRM/WhatsApp/Telegram, лицензирование, виджеты, расписания работы). Для каждой таблицы: назначение, ключевые колонки с типами, связи (FK), заметные индексы/hypertables (TimescaleDB) и pgvector-поля. Это справочный документ — пиши чётко и структурированно с заголовками и таблицами Markdown.`,
    { label: 'DB-SCHEMA.md', phase: 'Synthesize', agentType: 'general-purpose' }
  ),
  () => agent(
    `${CONTEXT}\n\nЗАДАЧА: создай файл reconstructed/ARCHITECTURE.md (на русском) — архитектуру системы.\nПрочитай: reconstructed/backend/ROUTES.md, reconstructed/*/APP_INDEX.json, docker-compose.yml, README.md (в корне), и несколько README.md из reconstructed/backend/app/*/.\nОпиши: 4 Bun-сервиса (backend API на Elysia; queue — воркер BullMQ; replication — consumer Debezium/Kafka; sync_schedules — синхронизация расписаний), их взаимодействие, поток данных (Asterisk ARI/AMI -> CDR -> AI-пайплайн -> аналитика/дашборды), внешние интеграции (Bitrix24, AmoCRM, WhatsApp, Telegram, AI Gateway), модель лицензирования, и карту модулей со ссылками в дерево reconstructed/. Используй ASCII-диаграммы где уместно.\n\nКраткие сводки задокументированных модулей для контекста:\n${summaryForArch}`,
    { label: 'ARCHITECTURE.md', phase: 'Synthesize', agentType: 'general-purpose' }
  ),
  () => agent(
    `${CONTEXT}\n\nЗАДАЧА: создай файл reconstructed/README.md (на русском) — путеводитель по каталогу reconstructed/.\nПрочитай существующий README.md в корне проекта и структуру reconstructed/ (через Glob/Bash: ls).\nОбъясни: что такое reconstructed/, разделение app/ (свой код, задокументирован) vs vendor/ (npm-зависимости, разбиты но не тронуты); что лежит в каждой категории app/ (routes, services, db, integrations, openlines, ai, licensing, schemas, workers, entry); где искать маршруты/сервисы/схему БД; метод реконструкции и ограничения (минифицированные имена переменных, отрезанный Bun-трейлер, vendor разбит но не переименован); ссылки на ROUTES.md, DB-SCHEMA.md, ARCHITECTURE.md. Добавь дерево каталогов верхнего уровня.`,
    { label: 'README.md', phase: 'Synthesize', agentType: 'general-purpose' }
  ),
]);

return {
  documentedGroups: ok.length,
  totalTasks: tasks.length,
  synthDocs: { dbDoc: !!dbDoc, archDoc: !!archDoc, navDoc: !!navDoc },
};
