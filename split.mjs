import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as acorn from 'acorn';
import prettier from 'prettier';

// Usage: node split.mjs <clean.js> <outDir>
const file = process.argv[2];
const outDir = process.argv[3];

const raw = readFileSync(file);
let cut = raw.indexOf(0x00); if (cut < 0) cut = raw.length;       // strip Bun binary trailer
const src = raw.slice(0, cut).toString('utf8');
console.error(`[split] ${file} -> ${outDir}  jsBytes=${src.length} (trailerCutAt=${cut}/${raw.length})`);

const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module',
  allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowSuperOutsideMethod: true, locations: true });

const calleeName = (n) => (n?.type === 'CallExpression' && n.callee?.type === 'Identifier') ? n.callee.name : null;

const MODULE_REF_RE = /\b((?:init_|require_)[A-Za-z0-9_$]+)\b/g;
const ROUTE_RE = /\.(get|post|put|delete|patch)\(\s*["'`](\/[A-Za-z0-9_\/:.\-{}]*)["'`]/g;
const DOMAIN_WORDS = ['cdr','bitrix24','amocrm','whatsapp','asterisk','operator','agent','work_schedule',
  'work_time','qa_','license','recording','transcri','session','deal','lead','blacklist','queue_operator',
  'openline','ari','ami','redpanda','debezium','llm','embedding','pgvector','widget','position','rubric',
  'channel','quick_repl','telegram'];
const VENDOR_CLASS = /^(Packr|Unpackr|Job|Queue|Queue\d|QueueBase|QueueGetters|QueueEvents|Worker\d?|Scripts|Elysia|PgDialect|PgSelect\w*|PgInsert\w*|PgUpdate\w*|PgDelete\w*|PgDatabase|PgSession|SQL|SQLWrapper|DateTime|Duration|Formatter|Interval|Info|Settings|Zone|FileTypeParser|JSONSchemaGenerator|OperationNodeTransformer|TypedQueryBuilder|QueryPromise|NodePg\w*|Unpackr|Packr|RedisConnection|Cluster\w*|Command|Pipeline|Redis|Reader|Writer)$/;

const snip = (s) => s.slice(0, 200).replace(/\s+/g, ' ').trim();

function score(name, slice, isModuleWrapper, domainHits, routeCount) {
  let s = 0; const why = [];
  if (/new Elysia\(\s*\{\s*(name|prefix)\s*:/.test(slice)) { s += 12; why.push('elysia-instance'); }
  if (/Controller\d*$/.test(name || '')) { s += 8; why.push('name:Controller'); }
  if (/(Service|ApiClient|Repository|Handler|Processor)\d*$/.test(name || '')) { s += 6; why.push('name:service'); }
  if (/^\s*class\s+\w+(\s+extends\s+\w+)?\s*\{\s*(drizzle|redis|drizzleDb)\b/.test(slice)) { s += 6; why.push('class-with-db-fields'); }
  if (/async function process[A-Z]\w*\s*\(/.test(slice)) { s += 9; why.push('job-processor'); }
  if (/^(var|let|const)\s+main\s*=/.test(slice) && /consumer\.(subscribe|connect|run)|new Worker\b|\.process\(/.test(slice)) { s += 8; why.push('worker-main'); }
  if (isModuleWrapper && domainHits.length >= 6) { s += 10; why.push('schema-module'); }
  if (/\w+Schema\d*$/.test(name || '') && /\bt\.Object\(|\bt\.Union\(|exports_external\d*\.(object|record)/.test(slice)) { s += 4; why.push('typebox-schema'); }
  if (/\bdrizzleDb\b|\bgetTableColumns\(|\bschema\./.test(slice)) { s += 2; why.push('db-ref'); }
  s += Math.min(domainHits.length, 5);
  if (routeCount > 0) s += 3;
  // vendor signals
  if (/content:\s*`--\[\[/.test(slice)) { s -= 14; why.push('bullmq-lua'); }
  if (/static\s*\[?entityKind\]?\s*=/.test(slice)) { s -= 12; why.push('drizzle-internal'); }
  if (/\[Kind\]|TypeCompiler|TSchema|TypeBoxError/.test(slice)) { s -= 10; why.push('typebox-internal'); }
  if (VENDOR_CLASS.test(name || '')) { s -= 10; why.push('vendor-class-name'); }
  if (/createAuthEndpoint\(|betterAuth\(|drizzleAdapter\(/.test(slice) && !/new Elysia/.test(slice)) { s -= 4; why.push('better-auth'); }
  return { s, why };
}

const units = [];           // every emittable unit
let prevBareVar = null;     // adjacent bare `var A,B;` to prepend to an esm module

for (const stmt of ast.body) {
  const stmtSrc = src.slice(stmt.start, stmt.end);

  // module wrappers (may be multi-declarator but in practice single)
  if (stmt.type === 'VariableDeclaration') {
    const moduleDecls = stmt.declarations.filter(d => { const c = calleeName(d.init); return c === '__esm' || c === '__commonJS'; });
    if (moduleDecls.length) {
      for (const d of moduleDecls) {
        const c = calleeName(d.init);
        let start = stmt.declarations.length === 1 ? stmt.start : d.start;
        let prefix = stmt.declarations.length === 1 ? '' : (stmt.kind + ' ');
        // attach adjacent preceding bare-var export bindings (ESM export hoist)
        let head = '';
        if (c === '__esm' && prevBareVar && (stmt.start - prevBareVar.end) < 3 && stmt.declarations.length === 1) {
          head = src.slice(prevBareVar.start, prevBareVar.end) + '\n';
        }
        const body = prefix + src.slice(d.start, d.end) + ';';
        const slice = head + body;
        const refs = new Set(); let m;
        MODULE_REF_RE.lastIndex = 0; while ((m = MODULE_REF_RE.exec(slice))) if (m[1] !== d.id.name) refs.add(m[1]);
        const lower = slice.toLowerCase();
        const domainHits = DOMAIN_WORDS.filter(w => lower.includes(w));
        const routeCount = (slice.match(ROUTE_RE) || []).length;
        const sc = score(d.id.name, slice, true, domainHits, routeCount);
        units.push({ name: d.id.name, kind: c === '__esm' ? 'esm-module' : 'cjs-module', src: slice,
          bytes: slice.length, refs: [...refs], routeCount, domainHits, score: sc.s, why: sc.why,
          isModuleWrapper: true, snippet: snip(slice) });
      }
      prevBareVar = null;
      continue;
    }
    // ordinary var statement: split per declarator into units (controllers etc.)
    const anyInit = stmt.declarations.some(d => d.init);
    if (!anyInit) { prevBareVar = stmt; continue; }   // bare bindings -> candidate ESM head
    for (const d of stmt.declarations) {
      const name = d.id.type === 'Identifier' ? d.id.name : `anon_${stmt.start}_${d.start}`;
      const slice = `${stmt.kind} ${src.slice(d.start, d.end)};`;
      const refs = new Set(); let m;
      MODULE_REF_RE.lastIndex = 0; while ((m = MODULE_REF_RE.exec(slice))) refs.add(m[1]);
      const lower = slice.toLowerCase();
      const domainHits = DOMAIN_WORDS.filter(w => lower.includes(w));
      const routeCount = (slice.match(ROUTE_RE) || []).length;
      const sc = score(name, slice, false, domainHits, routeCount);
      units.push({ name, kind: 'var', src: slice, bytes: slice.length, refs: [...refs], routeCount,
        domainHits, score: sc.s, why: sc.why, isModuleWrapper: false, snippet: snip(slice) });
    }
    prevBareVar = null;
    continue;
  }

  prevBareVar = null;
  let name, kind = stmt.type;
  if (stmt.type === 'FunctionDeclaration') name = stmt.id?.name;
  else if (stmt.type === 'ClassDeclaration') name = stmt.id?.name;
  else name = `${stmt.type}_${stmt.start}`;
  const slice = stmtSrc;
  const refs = new Set(); let m;
  MODULE_REF_RE.lastIndex = 0; while ((m = MODULE_REF_RE.exec(slice))) refs.add(m[1]);
  const lower = slice.toLowerCase();
  const domainHits = DOMAIN_WORDS.filter(w => lower.includes(w));
  const routeCount = (slice.match(ROUTE_RE) || []).length;
  const sc = score(name, slice, false, domainHits, routeCount);
  units.push({ name: name || `anon_${stmt.start}`, kind, src: slice, bytes: slice.length, refs: [...refs],
    routeCount, domainHits, score: sc.s, why: sc.why, isModuleWrapper: false, snippet: snip(slice) });
}

// ---- classify ----
const APP_THRESHOLD = 6;
for (const u of units) u.cls = u.score >= APP_THRESHOLD ? 'app' : 'vendor';

// runtime preamble = leading vendor units before first module/app unit that are __-helpers
let firstReal = units.findIndex(u => u.isModuleWrapper || u.cls === 'app');
if (firstReal < 0) firstReal = 0;

const appUnits = units.filter(u => u.cls === 'app');
const vendorModules = units.filter(u => u.cls === 'vendor' && u.isModuleWrapper);
const vendorInlined = units.filter(u => u.cls === 'vendor' && !u.isModuleWrapper);

console.error(`[split] units=${units.length}  app=${appUnits.length}  vendorModules=${vendorModules.length}  vendorInlined=${vendorInlined.length}`);

// ---- write files ----
rmSync(outDir, { recursive: true, force: true });
const dirs = ['app/_unsorted', 'vendor/modules', 'vendor/inlined'];
for (const d of dirs) mkdirSync(join(outDir, d), { recursive: true });

const usedNames = new Map();
function fileName(name) {
  let base = (name || 'unnamed').replace(/[^A-Za-z0-9_$.-]/g, '_').slice(0, 80);
  const n = (usedNames.get(base) || 0) + 1; usedNames.set(base, n);
  return n === 1 ? base : `${base}__${n}`;
}

async function prettyOrRaw(code) {
  try { return await prettier.format(code, { parser: 'babel', printWidth: 100, semi: true, singleQuote: false }); }
  catch { return code; }
}

const manifest = { file, jsBytes: src.length, totalUnits: units.length,
  counts: { app: appUnits.length, vendorModules: vendorModules.length, vendorInlined: vendorInlined.length },
  app: [], vendorModules: [], vendorInlined: [] };

// app units: prettify + write individually
for (const u of appUnits) {
  const fn = fileName(u.name) + '.js';
  const pretty = await prettyOrRaw(u.src);
  writeFileSync(join(outDir, 'app/_unsorted', fn), pretty);
  manifest.app.push({ name: u.name, file: `app/_unsorted/${fn}`, kind: u.kind, bytes: u.bytes,
    score: u.score, why: u.why, routeCount: u.routeCount,
    routes: (u.src.match(ROUTE_RE) || []).map(r => r.replace(ROUTE_RE, '$1 $2').toUpperCase()).slice(0, 60),
    domainHits: u.domainHits, refs: u.refs.slice(0, 30), snippet: u.snippet });
}

// vendor modules: one file each, untouched (minified)
for (const u of vendorModules) {
  const fn = fileName(u.name) + '.js';
  writeFileSync(join(outDir, 'vendor/modules', fn), u.src + '\n');
  manifest.vendorModules.push({ name: u.name, file: `vendor/modules/${fn}`, kind: u.kind, bytes: u.bytes,
    score: u.score, domainHits: u.domainHits, snippet: u.snippet });
}

// vendor inlined: chunk into ~400KB files in source order, but keep a per-unit index for review
let chunk = [], chunkBytes = 0, chunkIdx = 0;
const flushChunk = () => {
  if (!chunk.length) return;
  const fn = `inlined_${String(chunkIdx).padStart(3, '0')}.js`;
  writeFileSync(join(outDir, 'vendor/inlined', fn), chunk.join('\n\n') + '\n');
  chunkIdx++; chunk = []; chunkBytes = 0;
};
for (const u of vendorInlined) {
  chunk.push(`/* unit: ${u.name}  score=${u.score} */\n${u.src}`);
  chunkBytes += u.bytes;
  manifest.vendorInlined.push({ name: u.name, kind: u.kind, bytes: u.bytes, score: u.score, why: u.why,
    chunk: `vendor/inlined/inlined_${String(chunkIdx).padStart(3, '0')}.js`, domainHits: u.domainHits, snippet: u.snippet });
  if (chunkBytes > 400_000) flushChunk();
}
flushChunk();

writeFileSync(join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 1));
console.error(`[split] wrote ${appUnits.length} app files, ${vendorModules.length} vendor modules, ${chunkIdx} inlined chunks`);
console.error(`[split] MANIFEST: ${join(outDir, 'MANIFEST.json')}`);
