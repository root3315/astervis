import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Organize extracted turbopack modules into a reconstruction work-list:
//  - decode original source paths from SSR chunk filenames (new_admin_<path>_<ext>_<hash>)
//  - classify vendor vs app modules, build ID_MAP (id -> import specifier)
//  - wire routes (app-path-routes-manifest + SSR page/layout chunks + import graph)
//  - emit PATHMAP.json, ID_MAP.json, ROUTES.md, WORKLIST.json
// Usage: node tools/admin/organize.mjs   (run after extract.mjs)

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const NEXT = join(ROOT, 'admin', '.next');
const OUT = join(ROOT, 'reconstructed', 'admin', '_extract');

const M = JSON.parse(readFileSync(join(OUT, 'MODULES.json'), 'utf8'));
const modules = M.modules;                 // "kind:id" -> rec
const byKindId = (kind, id) => modules[`${kind}:${id}`];

// ---- 1. source-path decoding from chunk filenames ----
// chunk name: <groupHashPrefix>_<encoded-path>_<ext>_<hash>._.js
// APP files are TS/TSX with an app-root token and no package marker; everything else is vendor.
const APP_EXTS = ['tsx', 'ts', 'jsx'];
const ALL_EXTS = [...APP_EXTS, 'mjs', 'cjs', 'js', 'css', 'po', 'json'];
const APP_ROOTS = ['app', 'components', 'lib', 'hooks', 'stores', 'store', 'utils', 'util',
  'types', 'providers', 'provider', 'context', 'config', 'schemas', 'schema', 'services',
  'service', 'constants', 'i18n', 'styles', 'charts', 'features', 'modules-ui'];
const VENDOR_MARK = /(^|_)(node|modules|@[a-z0-9-]+|next|react|_pnpm|dist|esm|build|cjs|vendor)(_|$)|_mjs(_|$)|_pnpm_/;
const baseOf = (chunk) => chunk.split('/').pop();

// split "<...>_<ext>_<hash>" -> {head, ext}; head is everything before _<ext>
function splitExt(chunkBase) {
  let s = chunkBase.replace(/\.js$/, '').replace(/\._?$/, '').replace(/_$/, '');
  const extRe = new RegExp(`_(${ALL_EXTS.join('|')})(?=_|$)`, 'g');
  const ms = [...s.matchAll(extRe)];
  if (!ms.length) return null;
  const last = ms[ms.length - 1];
  return { head: s.slice(0, last.index), ext: last[1] };
}

// Decode an APP source path from a chunk basename, or null if vendor/internal/hash-only.
function decodeAppPath(chunkBase) {
  if (/_next-internal|_actions_[a-z0-9~.-]+$/.test(chunkBase)) return null; // server-action/internal stubs
  const se = splitExt(chunkBase);
  if (!se) return null;
  const { head, ext } = se;
  if (!APP_EXTS.includes(ext)) return null;                 // vendor compiled (.mjs/.cjs/.js)
  // find earliest app-root token position
  const toks = head.split('_');
  let rootIdx = -1;
  for (let i = 0; i < toks.length; i++) { if (APP_ROOTS.includes(toks[i])) { rootIdx = i; break; } }
  if (rootIdx < 0) return null;
  const pathToks = toks.slice(rootIdx);
  // reject if a package marker sits inside the path region (vendor leak)
  if (pathToks.some(t => t.startsWith('@') || t === 'node' || t === 'modules' || t === 'dist' || t === 'esm')) return null;
  return { pathPart: pathToks.join('_'), ext };
}

// Build exact encoder for known internal routes to preserve real underscores.
const routeMap = JSON.parse(readFileSync(join(NEXT, 'app-path-routes-manifest.json'), 'utf8')); // internal -> public
const internalRoutes = Object.keys(routeMap);
// encode a path the turbopack way: '/'->'_', drop leading '/'
const enc = (p) => p.replace(/^\//, '').replace(/\//g, '_');
// map encoded-app-pathPart -> correct source path, for page/layout/etc files
const knownAppEncoded = new Map();
for (const ir of internalRoutes) {
  // ir like /[locale]/work_schedules/report/page  -> file app/<...>.tsx
  const filePath = 'app' + ir;             // app/[locale]/work_schedules/report/page
  knownAppEncoded.set('app_' + enc(ir), filePath);
}

function pathPartToSource(pathPart, ext) {
  // exact match for app pages/layouts (preserves real underscores via route manifest)
  if (knownAppEncoded.has(pathPart)) return knownAppEncoded.get(pathPart) + '.' + ext;
  // app/<route>/layout|template|loading|error|not-found: try trimming trailing segment
  if (pathPart.startsWith('app_')) {
    const parts = pathPart.split('_');
    const leaf = parts[parts.length - 1];
    const parentEnc = parts.slice(0, -1).join('_');
    if (['layout', 'template', 'loading', 'error', 'default', 'route', 'page'].includes(leaf)) {
      // find a known route whose encoded parent matches
      for (const [k, v] of knownAppEncoded) {
        const kParent = k.split('_').slice(0, -1).join('_');
        if (kParent === parentEnc) return v.split('/').slice(0, -1).join('/') + '/' + leaf + '.' + ext;
      }
    }
  }
  // generic: underscores -> '/', keep brackets/parens/dashes
  return pathPart.replace(/_/g, '/') + '.' + ext;
}

// ---- 2. assign source paths to SSR modules via their best (path-named) chunk ----
const pathmap = {};   // sourcePath -> { ssrId, exports, kind, role, ... }
const idToPath = {};  // "ssr:id" -> sourcePath
for (const rec of Object.values(modules)) {
  if (rec.kind !== 'ssr') continue;
  let best = null;
  for (const chunk of rec.chunks) {
    const dec = decodeAppPath(baseOf(chunk));
    if (dec) { best = dec; break; }        // first chunk that encodes an app path
  }
  if (!best) continue;
  const src = pathPartToSource(best.pathPart, best.ext);
  rec.sourcePath = src;
  idToPath[`ssr:${rec.id}`] = src;
  // a source file may map to >1 module (rare); keep the one with most exports/bytes
  if (!pathmap[src] || rec.bytes > pathmap[src].bytes) {
    pathmap[src] = { ssrId: rec.id, exports: rec.exportNames, bytes: rec.bytes,
      hasJsx: rec.hasJsx, hasUseHook: rec.hasUseHook, serverActions: rec.serverActions,
      reactCompiler: rec.usesReactCompiler };
  }
}

// ---- 3. classify vendor vs app, build ID_MAP ----
// vendor export-signature -> package
const VENDOR_SIG = [
  [['useTranslations', 'IntlProvider', 'useFormatter'], 'next-intl'],
  [['Chart', 'ArcElement', 'BarController', 'LineElement'], 'chart.js'],
  [['createColumnHelper', 'useReactTable', 'getCoreRowModel'], '@tanstack/react-table'],
  [['DndContext', 'useSortable', 'closestCenter'], '@dnd-kit/core'],
  [['DayButton', 'MonthGrid', 'Weekday', 'formatCaption'], 'react-day-picker'],
  [['QueryClient', 'useQuery', 'useMutation', 'QueryClientProvider'], '@tanstack/react-query'],
  [['useForm', 'Controller', 'FormProvider', 'useFieldArray'], 'react-hook-form'],
  [['motion', 'AnimatePresence', 'useAnimate'], 'framer-motion'],
  [['toast', 'Toaster'], 'sonner'],
];
// extract a package specifier from a vendor chunk basename
function pkgFromChunk(base) {
  let s = base.replace(/\.js$/, '');
  // pnpm layout: ..._pnpm_<scope+pkg>@<ver>_..._node_modules_<path>
  let m = s.match(/_pnpm_((?:@[a-z0-9-]+\+)?[a-z0-9._-]+)@/i);
  if (m) return m[1].replace('+', '/');
  // scoped pkg token sequence: _@scope_pkg_
  m = s.match(/_(@[a-z0-9-]+)_([a-z0-9.-]+)_/i);
  if (m) return `${m[1]}/${m[2]}`;
  // next.js internals
  if (/(^|_)next_dist|0luq_next/.test(s)) return 'next';
  // bare pkg before a dist/build/esm/lib/index marker: _<pkg>_(dist|build|esm|lib|index)
  m = s.match(/_([a-z0-9-]+)_(dist|build|esm|lib|index|src)_/i);
  if (m && m[1] !== 'admin') return m[1];
  return null;
}
const isVendorChunk = (c) => /node_modules|_next_dist|0luq_next|[\[]turbopack[\]]|_pnpm_|@[a-z0-9-]+_|_dist_|_esm_|_build_|_mjs(_|$)/.test(c);
function classify(rec) {
  if (rec.sourcePath) return { kind: 'app', spec: rec.sourcePath };
  // any chunk decodes to an app path? (non-ssr kinds, or ssr that lost the race) -> app-internal
  const appChunk = rec.chunks.find(c => decodeAppPath(baseOf(c)));
  if (appChunk) return { kind: 'app-internal', spec: null };
  // vendor: try export signature, then chunk-name pkg extraction
  for (const [sig, pkg] of VENDOR_SIG) {
    if (sig.length && sig.every(s => rec.exportNames.includes(s))) return { kind: 'vendor', spec: pkg };
  }
  for (const c of rec.chunks) { const p = pkgFromChunk(baseOf(c)); if (p) return { kind: 'vendor', spec: p }; }
  if (rec.chunks.every(isVendorChunk)) return { kind: 'vendor', spec: null };
  return { kind: 'app-internal', spec: null };
}
const idMap = {};   // "kind:id" -> {class, spec}
const counts = { app: 0, 'app-internal': 0, vendor: 0, vendorNamed: 0 };
for (const rec of Object.values(modules)) {
  const c = classify(rec);
  idMap[`${rec.kind}:${rec.id}`] = { class: c.kind, spec: c.spec, exports: rec.exportNames.slice(0, 8) };
  counts[c.kind] = (counts[c.kind] || 0) + 1;
  if (c.kind === 'vendor' && c.spec) counts.vendorNamed++;
}

// ---- 4. routes: internal route -> page/layout source files ----
const routeRows = [];
for (const ir of internalRoutes) {
  const pageFile = 'app' + ir + '.tsx';      // app/<ir>.tsx (page or route)
  const pm = pathmap[pageFile] || pathmap['app' + ir + '.ts'];
  routeRows.push({ internal: ir, public: routeMap[ir], file: pageFile, found: !!pm, ssrId: pm?.ssrId ?? null });
}

// ---- 5. emit ----
const appFiles = Object.keys(pathmap).sort();
const byDir = {};
for (const p of appFiles) { const top = p.split('/').slice(0, 2).join('/'); byDir[top] = (byDir[top] || 0) + 1; }

writeFileSync(join(OUT, 'PATHMAP.json'), JSON.stringify(pathmap, null, 0));
writeFileSync(join(OUT, 'ID_MAP.json'), JSON.stringify(idMap, null, 0));

const worklist = appFiles.map(p => ({ path: p, ...pathmap[p] }));
writeFileSync(join(OUT, 'WORKLIST.json'), JSON.stringify({ count: worklist.length, files: worklist }, null, 0));

let md = `# Astervis admin — reconstruction routes & file inventory\n\n`;
md += `Recovered app source files: **${appFiles.length}** (from SSR chunk names)\n\n## Files per top-dir\n\n`;
for (const [d, n] of Object.entries(byDir).sort((a, b) => b[1] - a[1])) md += `- \`${d}/\` — ${n}\n`;
md += `\n## Routes (internal → public → page file)\n\n`;
for (const r of routeRows) md += `- ${r.found ? '✅' : '❌'} \`${r.public}\` ← \`${r.file}\`${r.ssrId ? ` (mod ${r.ssrId})` : ''}\n`;
md += `\n## All recovered app files\n\n`;
for (const p of appFiles) md += `- \`${p}\`${pathmap[p].exports.length ? ` — exports: ${pathmap[p].exports.slice(0, 6).join(', ')}` : ''}\n`;
writeFileSync(join(OUT, 'ROUTES.md'), md);

console.error(`[organize] app source files recovered: ${appFiles.length}`);
console.error(`[organize] classify:`, JSON.stringify(counts));
console.error(`[organize] routes matched: ${routeRows.filter(r => r.found).length}/${routeRows.length}`);
console.error(`[organize] top dirs:`, JSON.stringify(byDir));
console.error(`[organize] wrote PATHMAP.json ID_MAP.json WORKLIST.json ROUTES.md`);
