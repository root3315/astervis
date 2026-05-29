import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import * as acorn from 'acorn';

// Usage: node analyze.mjs <clean.js> <outManifest.json>
const file = process.argv[2];
const outManifest = process.argv[3];

const raw = readFileSync(file);
// Cut the Bun binary trailer: JS payload ends at the first NUL byte.
let cut = raw.indexOf(0x00);
if (cut < 0) cut = raw.length;
const src = raw.slice(0, cut).toString('utf8');
console.error(`[analyze] ${file}: rawBytes=${raw.length} jsBytes=${src.length} trailerCutAt=${cut}`);

const t0 = Date.now();
const ast = acorn.parse(src, {
  ecmaVersion: 'latest',
  sourceType: 'module',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowSuperOutsideMethod: true,
  locations: true,
});
console.error(`[analyze] parsed in ${Date.now() - t0}ms, top-level stmts=${ast.body.length}`);

function calleeName(node) {
  if (node?.type === 'CallExpression' && node.callee?.type === 'Identifier') return node.callee.name;
  return null;
}

// Collect identifiers referenced inside a source slice (cheap regex, good enough for graph signal)
const MODULE_REF_RE = /\b((?:init_|require_)[A-Za-z0-9_$]+)\b/g;
const ROUTE_RE = /\.(get|post|put|delete|patch)\(\s*["'`](\/[A-Za-z0-9_/:.\-{}]*)["'`]/g;
const DOMAIN_WORDS = ['cdr','bitrix24','amocrm','whatsapp','asterisk','operator','agent','work_schedule',
  'qa_','license','recording','transcri','session','deal','lead','blacklist','queue_operator','openline',
  'ari','ami','redpanda','debezium','llm','embedding','pgvector','widget','position','rubric'];

const modules = [];
let prevBareVar = null; // VariableDeclaration with no initializers immediately preceding

for (let i = 0; i < ast.body.length; i++) {
  const stmt = ast.body[i];
  if (stmt.type === 'VariableDeclaration') {
    let modDecl = null, modKind = null, modName = null;
    for (const d of stmt.declarations) {
      const cn = calleeName(d.init);
      if (cn === '__esm') { modKind = 'esm'; modName = d.id.name; modDecl = d; }
      else if (cn === '__commonJS') { modKind = 'cjs'; modName = d.id.name; modDecl = d; }
    }
    if (modDecl) {
      // module body: include preceding bare-var export bindings (ESM pattern) if adjacent
      let start = stmt.start;
      if (prevBareVar && prevBareVar.end <= stmt.start && (stmt.start - prevBareVar.end) < 3) {
        start = prevBareVar.start;
      }
      const slice = src.slice(start, stmt.end);
      const refs = new Set();
      let m;
      MODULE_REF_RE.lastIndex = 0;
      while ((m = MODULE_REF_RE.exec(slice))) { if (m[1] !== modName) refs.add(m[1]); }
      const routes = [];
      ROUTE_RE.lastIndex = 0;
      while ((m = ROUTE_RE.exec(slice))) routes.push(`${m[1].toUpperCase()} ${m[2]}`);
      const lower = slice.toLowerCase();
      const domainHits = DOMAIN_WORDS.filter(w => lower.includes(w));
      modules.push({
        index: modules.length,
        name: modName,
        kind: modKind,
        start, end: stmt.end,
        bytes: stmt.end - start,
        startLine: acorn.getLineInfo ? src.slice(0, start).split('\n').length : null,
        refCount: refs.size,
        refs: [...refs],
        routeCount: routes.length,
        routes: routes.slice(0, 40),
        domainHits,
        hasElysia: /new Elysia\b/.test(slice),
        hasDrizzleTable: /pgTable\(|sql`|drizzle/i.test(slice),
      });
      prevBareVar = null;
      continue;
    }
    // not a module wrapper
    const anyInit = stmt.declarations.some(d => d.init);
    prevBareVar = anyInit ? null : stmt;
  } else {
    prevBareVar = null;
  }
}

console.error(`[analyze] modules: esm=${modules.filter(m=>m.kind==='esm').length} cjs=${modules.filter(m=>m.kind==='cjs').length}`);

const manifest = {
  file, rawBytes: raw.length, jsBytes: src.length, trailerCutAt: cut,
  topLevelStmts: ast.body.length, moduleCount: modules.length, modules,
};
mkdirSync(outManifest.replace(/[^/\\]+$/, '') || '.', { recursive: true });
writeFileSync(outManifest, JSON.stringify(manifest, null, 1));

// Summary: ESM modules with route/domain signal (likely app code)
const appish = modules.filter(m => m.kind === 'esm' && (m.routeCount > 0 || m.hasElysia || m.domainHits.length >= 2));
console.error(`[analyze] esm modules w/ app signal (routes/elysia/2+domain): ${appish.length}`);
console.error(`[analyze] top app-signal modules:`);
for (const m of appish.sort((a,b)=>b.routeCount-a.routeCount).slice(0, 30)) {
  console.error(`  ${m.name}  bytes=${m.bytes} routes=${m.routeCount} elysia=${m.hasElysia} domains=[${m.domainHits.join(',')}]`);
}
