import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as acorn from 'acorn';

// Deterministic inventory: parse a Bun bundle, strip trailer, extract every top-level unit
// with byte offsets + heuristic app-score, write vendor module files + _payload.js + MANIFEST.json.
// Usage: node index.mjs <clean.js> <outDir>
const file = process.argv[2];
const outDir = process.argv[3];

const raw = readFileSync(file);
let cut = raw.indexOf(0x00); if (cut < 0) cut = raw.length;
const src = raw.slice(0, cut).toString('utf8');
console.error(`[index] ${file} jsBytes=${src.length} (trailerCutAt=${cut}/${raw.length})`);

const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module',
  allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowSuperOutsideMethod: true, locations: true });

const calleeName = (n) => (n?.type === 'CallExpression' && n.callee?.type === 'Identifier') ? n.callee.name : null;
const MODULE_REF_RE = /\b((?:init_|require_)[A-Za-z0-9_$]+)\b/g;
const ROUTE_RE = /\.(get|post|put|delete|patch)\(\s*["'`](\/[A-Za-z0-9_\/:.\-{}]*)["'`]/g;
const DOMAIN_WORDS = ['cdr','bitrix24','amocrm','whatsapp','asterisk','operator','agent','work_schedule',
  'work_time','qa_','license','recording','transcri','session','deal','lead','blacklist','queue_operator',
  'openline','ari','ami','redpanda','debezium','llm','embedding','pgvector','widget','position','rubric',
  'channel','quick_repl','telegram','dialplan','sip','pjsip','voicemail'];
const VENDOR_CLASS = /^(Packr|Unpackr|Job|Queue\d?|QueueBase|QueueGetters|QueueEvents|Worker\d?|Scripts|Elysia|Pg[A-Z]\w*|Node[A-Z]\w*|SQL\w*|DateTime|Duration|Formatter|Interval|Info|Settings|Zone|FileTypeParser|JSONSchemaGenerator|OperationNode\w*|Typed\w*|QueryPromise|RedisConnection|Cluster\w*|Command|Pipeline|Redis|Reader|Writer|Tokenizer\w*)$/;
const snip = (s) => s.slice(0, 220).replace(/\s+/g, ' ').trim();
const DOMAIN_RE = DOMAIN_WORDS.map(w => ({ w, re: new RegExp('\\b' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }));
const domainHitsOf = (slice) => DOMAIN_RE.filter(({ re }) => re.test(slice)).map(({ w }) => w);

function score(name, slice, isModuleWrapper, domainHits, routeCount) {
  let s = 0; const why = [];
  if (/new Elysia\(\s*\{\s*(name|prefix)\s*:/.test(slice)) { s += 12; why.push('elysia'); }
  if (/Controller\d*$/.test(name || '')) { s += 8; why.push('Controller'); }
  if (/(Service|ApiClient|Repository|Provider|Manager)\d*$/.test(name || '')) { s += 6; why.push('service-name'); }
  if (/^\s*(var|let|const)?\s*class\s+\w+(\s+extends\s+\w+)?\s*\{\s*(drizzle|redis|drizzleDb)\b/.test(slice)) { s += 6; why.push('db-class'); }
  if (/async function process[A-Z]\w*\s*\(/.test(slice)) { s += 9; why.push('processor'); }
  if (/^(var|let|const)\s+main\s*=/.test(slice) && /consumer\.(subscribe|connect|run)|new Worker\b|\.process\(/.test(slice)) { s += 8; why.push('worker-main'); }
  if (isModuleWrapper && domainHits.length >= 6) { s += 10; why.push('schema-module'); }
  if (/\w+Schema\d*$/.test(name || '') && /\bt\.Object\(|\bt\.Union\(|exports_external\d*\.(object|record)/.test(slice)) { s += 4; why.push('schema'); }
  if (/\bdrizzleDb\b|\bgetTableColumns\(/.test(slice)) { s += 2; why.push('db-ref'); }
  s += Math.min(domainHits.length, 5);
  if (routeCount > 0) s += 3;
  if (/content:\s*`--\[\[/.test(slice)) { s -= 14; why.push('-lua'); }
  if (/static\s*\[?entityKind\]?\s*=/.test(slice)) { s -= 12; why.push('-drizzle-internal'); }
  if (/\[Kind\]|TypeCompiler|TSchema|TypeBoxError/.test(slice)) { s -= 10; why.push('-typebox'); }
  if (VENDOR_CLASS.test(name || '')) { s -= 10; why.push('-vendor-class'); }
  return { s, why };
}

const units = [];
let prevBareVar = null;
let idx = 0;

function pushUnit(name, kind, start, end, headStart, isModuleWrapper) {
  const slice = src.slice(headStart ?? start, end);
  const refs = new Set(); let m;
  MODULE_REF_RE.lastIndex = 0; while ((m = MODULE_REF_RE.exec(slice))) if (m[1] !== name) refs.add(m[1]);
  const domainHits = domainHitsOf(slice);
  const routeCount = (slice.match(ROUTE_RE) || []).length;
  const routes = []; ROUTE_RE.lastIndex = 0;
  while ((m = ROUTE_RE.exec(slice))) routes.push(`${m[1].toUpperCase()} ${m[2]}`);
  const sc = score(name, slice, isModuleWrapper, domainHits, routeCount);
  units.push({ index: idx++, name: name || `anon_${start}`, kind, start: headStart ?? start, end, bytes: slice.length,
    isModuleWrapper, score: sc.s, why: sc.why, domainHits, routeCount, routes: routes.slice(0, 70),
    refs: [...refs].slice(0, 40), snippet: snip(slice) });
}

for (const stmt of ast.body) {
  if (stmt.type === 'VariableDeclaration') {
    const moduleDecls = stmt.declarations.filter(d => { const c = calleeName(d.init); return c === '__esm' || c === '__commonJS'; });
    if (moduleDecls.length) {
      for (const d of moduleDecls) {
        const c = calleeName(d.init);
        const single = stmt.declarations.length === 1;
        let headStart = single ? stmt.start : d.start;
        if (c === '__esm' && single && prevBareVar && (stmt.start - prevBareVar.end) < 3) headStart = prevBareVar.start;
        pushUnit(d.id.name, c === '__esm' ? 'esm-module' : 'cjs-module', d.start, single ? stmt.end : d.end, headStart, true);
      }
      prevBareVar = null; continue;
    }
    const anyInit = stmt.declarations.some(d => d.init);
    if (!anyInit) { prevBareVar = stmt; continue; }
    for (const d of stmt.declarations) {
      const name = d.id.type === 'Identifier' ? d.id.name : `anon_${d.start}`;
      pushUnit(name, 'var', d.start, d.end, null, false);
    }
    prevBareVar = null; continue;
  }
  prevBareVar = null;
  let name;
  if (stmt.type === 'FunctionDeclaration') name = stmt.id?.name;
  else if (stmt.type === 'ClassDeclaration') name = stmt.id?.name;
  else name = `${stmt.type}_${stmt.start}`;
  pushUnit(name, stmt.type, stmt.start, stmt.end, null, false);
}

// write outputs
rmSync(outDir, { recursive: true, force: true });
mkdirSync(join(outDir, 'vendor/modules'), { recursive: true });
writeFileSync(join(outDir, '_payload.js'), src);

const used = new Map();
const fname = (name) => { let b = (name || 'unnamed').replace(/[^A-Za-z0-9_$.-]/g, '_').slice(0, 80);
  const n = (used.get(b) || 0) + 1; used.set(b, n); return n === 1 ? b : `${b}__${n}`; };

for (const u of units) {
  if (u.kind === 'esm-module' || u.kind === 'cjs-module') {
    const fn = fname(u.name) + '.js';
    writeFileSync(join(outDir, 'vendor/modules', fn), src.slice(u.start, u.end) + '\n');
    u.vendorFile = `vendor/modules/${fn}`;
  }
}

const APP_HINT = 6;
const appCandidates = units.filter(u => !u.isModuleWrapper && u.score >= APP_HINT).length;
const manifest = { file, jsBytes: src.length, totalUnits: units.length,
  moduleWrappers: units.filter(u => u.isModuleWrapper).length,
  appCandidates, units };
writeFileSync(join(outDir, 'MANIFEST.json'), JSON.stringify(manifest, null, 0));
console.error(`[index] units=${units.length} modules=${manifest.moduleWrappers} appCandidates(score>=${APP_HINT})=${appCandidates}`);
console.error(`[index] wrote vendor/modules, _payload.js, MANIFEST.json`);
