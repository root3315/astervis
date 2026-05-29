import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as acorn from 'acorn';

// Turbopack module extractor for the Next.js admin (.next) build.
//
// Two module-table formats:
//   CLIENT (static/chunks/*.js):
//     (globalThis.TURBOPACK ||= []).push([currentScript, <id>, <factory>])   -- factory: (ctx)=>{...} or (e,t,r)=>{...}
//   SERVER (server/chunks/*.js):
//     module.exports = [<id>, <factory(e,r,t)>, <id>, <factory>, ...]
//
// Turbopack context API (from the unminified [turbopack]_runtime.js):
//   ctx.i(id)=esmImport  ctx.r(id)=commonJsRequire  ctx.t(id)=runtimeRequire
//   ctx.A/.l(id)=async/dynamic import   ctx.s({name:()=>local})=esmExport
//   ctx.v(x)=exportValue(cjs default)   ctx.n(x)=exportNamespace   ctx.j=dynamicExport
//
// Output: reconstructed/admin/_extract/{MODULES.json, modules/<kind>/<id>.js}
// Usage: node tools/admin/extract.mjs

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const NEXT = join(ROOT, 'admin', '.next');
const OUT = join(ROOT, 'reconstructed', 'admin', '_extract');

const IMPORT_VIA = { i: 'esmImport', r: 'commonJsRequire', t: 'runtimeRequire', A: 'asyncLoader', l: 'loadChunk', L: 'loadChunkUrl' };
const EXPORT_VIA = { s: 'esmExport', v: 'exportValue', n: 'exportNamespace', j: 'dynamicExport' };

const parse = (src) => acorn.parse(src, {
  ecmaVersion: 'latest', sourceType: 'script', locations: false,
  allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowSuperOutsideMethod: true,
});

// recursive AST walker (lightweight; visits all child nodes)
function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key in node) {
    if (key === 'type' || key === 'start' || key === 'end') continue;
    const child = node[key];
    if (Array.isArray(child)) { for (const c of child) if (c && typeof c.type === 'string') walk(c, visit); }
    else if (child && typeof child.type === 'string') walk(child, visit);
  }
}

const isFn = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression');
const numLit = (n) => (n && n.type === 'Literal' && typeof n.value === 'number') ? n.value : null;

// Analyse one module factory: ctx param, imports (ids), export names, flags.
function analyseFactory(src, factory) {
  const ctxParams = (factory.params || []).filter(p => p && p.type === 'Identifier').map(p => p.name);
  const ctx = ctxParams[0];
  const imports = [];       // {id, via}
  const exportNames = new Set();
  const serverActions = [];
  let cjsDefault = false, dynamicExportArg = false;
  if (ctx) {
    walk(factory.body, (n) => {
      if (n.type !== 'CallExpression') return;
      let callee = n.callee;
      // unwrap (0, x.method)(...) sequence-expression call form
      if (callee?.type === 'SequenceExpression') callee = callee.expressions[callee.expressions.length - 1];
      // createServerReference("hash", callServer, undefined, findSourceMapURL, "actionName")
      if (callee?.type === 'MemberExpression' && callee.property?.name === 'createServerReference') {
        const args = n.arguments || [];
        const last = args[args.length - 1];
        if (last?.type === 'Literal' && typeof last.value === 'string') serverActions.push(last.value);
      }
      if (callee?.type !== 'MemberExpression' || callee.computed) return;
      if (callee.object?.type !== 'Identifier' || callee.object.name !== ctx) return;
      const m = callee.property?.name;
      const a0 = n.arguments?.[0];
      if (IMPORT_VIA[m]) {
        const id = numLit(a0);
        if (id != null) imports.push({ id, via: IMPORT_VIA[m] });
      } else if (m === 's') {
        // client: e.s([name,flag,getter, ...], id)   server: e.s({name:()=>local})
        if (a0?.type === 'ArrayExpression') {
          for (const el of a0.elements) {
            if (el?.type === 'Literal' && typeof el.value === 'string') exportNames.add(el.value);
          }
        } else if (a0?.type === 'ObjectExpression') {
          for (const p of a0.properties) {
            if (p.type === 'Property') {
              const key = p.key?.type === 'Identifier' ? p.key.name : (p.key?.type === 'Literal' ? String(p.key.value) : null);
              if (key) exportNames.add(key);
            }
          }
        }
      } else if (m === 'v') cjsDefault = true;
      else if (m === 'n' || m === 'j') dynamicExportArg = true;
    });
  }
  const slice = src.slice(factory.start, factory.end);
  return {
    ctxParam: ctx || null,
    ctxParams,
    imports,
    exportNames: [...exportNames],
    serverActions: [...new Set(serverActions)],
    cjsDefault,
    dynamicExportArg,
    bytes: slice.length,
    hasJsx: /\.jsxs?\)|\bjsxs?\(|jsxDEV|\.createElement\(/.test(slice),
    hasUseHook: /\buse(State|Effect|Query|Mutation|Form|Router|Translations|Memo|Callback|Ref|Context|Store|Pathname|SearchParams)\b/.test(slice),
    usesReactCompiler: /memo_cache_sentinel|\(0,\w+\.c\)\(\d+\)/.test(slice),
    snippet: slice.slice(0, 240).replace(/\s+/g, ' ').trim(),
  };
}

// Collect [id, factoryNode] pairs from a chunk file. format: 'server' (module.exports=[...]) | 'client' (TURBOPACK.push)
function collectModules(src, format) {
  let ast;
  try { ast = parse(src); }
  catch (e) { return { error: e.message, modules: [] }; }
  const modules = [];

  if (format === 'server') {
    // module.exports = [id, factory, id, factory, ...]
    walk(ast, (n) => {
      if (n.type !== 'AssignmentExpression') return;
      const l = n.left;
      const isModuleExports = l?.type === 'MemberExpression' && l.object?.name === 'module' && l.property?.name === 'exports';
      if (!isModuleExports || n.right?.type !== 'ArrayExpression') return;
      const els = n.right.elements;
      for (let i = 0; i < els.length - 1; i++) {
        const id = numLit(els[i]);
        if (id != null && isFn(els[i + 1])) { modules.push({ id, factory: els[i + 1] }); i++; }
      }
    });
  } else {
    // (globalThis.TURBOPACK ...).push([currentScript, id, factory], [...], ...)
    walk(ast, (n) => {
      if (n.type !== 'CallExpression') return;
      const callee = n.callee;
      if (callee?.type !== 'MemberExpression' || callee.property?.name !== 'push') return;
      // confirm the push target mentions TURBOPACK somewhere in the callee object source
      const objSrc = src.slice(callee.object.start, callee.object.end);
      if (!objSrc.includes('TURBOPACK')) return;
      for (const arg of n.arguments) {
        if (arg?.type !== 'ArrayExpression') continue;
        const els = arg.elements;
        // find [ , id(number), factory(fn) ] — id and factory adjacency
        for (let i = 0; i < els.length - 1; i++) {
          const id = numLit(els[i]);
          if (id != null && isFn(els[i + 1])) { modules.push({ id, factory: els[i + 1] }); break; }
        }
      }
    });
  }
  return { modules };
}

function listJs(dir) {
  try { return readdirSync(dir).filter(f => f.endsWith('.js')).map(f => join(dir, f)); }
  catch { return []; }
}

// ---- run ----
rmSync(OUT, { recursive: true, force: true });
for (const k of ['server', 'client', 'ssr']) mkdirSync(join(OUT, 'modules', k), { recursive: true });

const index = {};   // "kind:id" -> record
const dup = [];
let files = 0, parseErrors = [];

// [kindLabel, dir, format]. ssr/ holds the SSR-compiled app components whose CHUNK FILENAMES encode source paths.
const SOURCES = [
  ['server', join(NEXT, 'server', 'chunks'), 'server'],
  ['ssr', join(NEXT, 'server', 'chunks', 'ssr'), 'server'],
  ['client', join(NEXT, 'static', 'chunks'), 'client'],
];
for (const [kind, dir, format] of SOURCES) {
  for (const fp of listJs(dir)) {
    files++;
    const src = readFileSync(fp, 'utf8');
    const chunkName = fp.slice(NEXT.length + 1).replace(/\\/g, '/');
    const { error, modules } = collectModules(src, format);
    if (error) { parseErrors.push(`${chunkName}: ${error}`); continue; }
    for (const { id, factory } of modules) {
      const info = analyseFactory(src, factory);
      const key = `${kind}:${id}`;
      if (index[key]) { dup.push(key); index[key].chunks.push(chunkName); continue; }
      const rel = `modules/${kind}/${id}.js`;
      writeFileSync(join(OUT, rel), src.slice(factory.start, factory.end) + '\n');
      index[key] = {
        id, kind, chunk: chunkName, chunks: [chunkName], file: rel,
        ctxParam: info.ctxParam, ctxParams: info.ctxParams,
        importIds: info.imports.map(x => x.id), imports: info.imports,
        exportNames: info.exportNames, cjsDefault: info.cjsDefault,
        serverActions: info.serverActions, isComponent: info.hasJsx,
        hasJsx: info.hasJsx, hasUseHook: info.hasUseHook, usesReactCompiler: info.usesReactCompiler,
        bytes: info.bytes, snippet: info.snippet,
      };
    }
  }
}

const recs = Object.values(index);
const manifest = {
  generatedFrom: 'admin/.next',
  files, totalModules: recs.length,
  server: recs.filter(r => r.kind === 'server').length,
  ssr: recs.filter(r => r.kind === 'ssr').length,
  client: recs.filter(r => r.kind === 'client').length,
  clientWithJsx: recs.filter(r => r.kind === 'client' && r.hasJsx).length,
  clientWithExports: recs.filter(r => r.kind === 'client' && r.exportNames.length).length,
  withServerActions: recs.filter(r => r.serverActions.length).length,
  parseErrors: parseErrors.length, duplicates: dup.length,
  modules: index,
};
writeFileSync(join(OUT, 'MODULES.json'), JSON.stringify(manifest, null, 0));

console.error(`[extract] files=${files} modules=${recs.length} (server=${manifest.server} client=${manifest.client}, clientWithJsx=${manifest.clientWithJsx})`);
console.error(`[extract] parseErrors=${parseErrors.length} duplicates=${dup.length}`);
if (parseErrors.length) parseErrors.slice(0, 15).forEach(e => console.error('  !! ' + e));
console.error(`[extract] wrote ${OUT}`);
