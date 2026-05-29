import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve every dangling "@/components/charts/(group)/Name" import to the SSR module
// whose chunk filename encodes that group segment (charts export `default`, so we match
// by the path segment in the chunk name, not by export name).
const ADMIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reconstructed', 'admin');
const M = JSON.parse(readFileSync(join(ADMIN, '_extract', 'MODULES.json'), 'utf8')).modules;
const baseOf = (c) => c.split('/').pop();

function walk(d, a = []) {
  for (const e of readdirSync(d)) {
    if (['node_modules', '_extract', '.next'].includes(e)) continue;
    const p = join(d, e); const s = statSync(p);
    if (s.isDirectory()) walk(p, a); else if (/\.(ts|tsx)$/.test(e)) a.push(p);
  }
  return a;
}
const files = walk(ADMIN);
const want = new Map();   // spec -> {group, name}
// match both `from "..."` and dynamic `import("...")`
const re = /(?:from|import)\s*\(?\s*["'](@\/components\/charts\/[^"']+)["']/g;
const EXTS = ['', '.ts', '.tsx'];
for (const f of files) {
  const s = readFileSync(f, 'utf8'); let m;
  while ((m = re.exec(s))) {
    const spec = m[1];
    if (EXTS.some((e) => existsSync(join(ADMIN, spec.replace(/^@\//, '') + e)))) continue;
    const parts = spec.split('/');                       // .../charts/(group)/Name
    const name = parts.pop();
    const group = (parts.pop() || '').replace(/^\(|\)$/g, '');  // strip ( )
    want.set(spec, { group, name, path: spec.replace(/^@\//, '') + '.tsx' });
  }
}
// content-scan all ssr module files once; for each chart name find its DEFINING module
// (the non-registry module whose code declares it). Charts are merged a few-per-module.
const MODDIR = join(ADMIN, '_extract', 'modules', 'ssr');
const ssrFiles = readdirSync(MODDIR).filter((f) => f.endsWith('.js'));
const content = new Map();   // id -> source
for (const f of ssrFiles) content.set(+f.replace('.js', ''), readFileSync(join(MODDIR, f), 'utf8'));

const rows = [];
for (const [spec, info] of want) {
  const reName = new RegExp('\\b' + info.name + '\\b');
  let hits = [];
  for (const [id, src] of content) {
    if (id === 214344) continue;                 // skip the widget registry
    if (reName.test(src)) hits.push({ id, b: (M['ssr:' + id]?.bytes || src.length), jsx: M['ssr:' + id]?.hasJsx });
  }
  // prefer jsx modules; among them the SMALLEST that contains it (most specific bundle)
  hits = hits.filter((h) => h.jsx).sort((a, b) => a.b - b.b);
  const best = hits[0] || null;
  rows.push({ ...info, ssrId: best?.id || null, bytes: best?.b || 0 });
}
rows.sort((a, b) => (a.ssrId || 0) - (b.ssrId || 0));
// group by defining module
const byMod = {};
for (const r of rows) if (r.ssrId) (byMod[r.ssrId] = byMod[r.ssrId] || []).push(r.name);
console.log('dangling chart components:', rows.length, '| resolved:', rows.filter((r) => r.ssrId).length);
console.log('defining modules:', Object.keys(byMod).length);
for (const [id, names] of Object.entries(byMod).sort((a, b) => b[1].length - a[1].length))
  console.log('  ssr:' + id + '  (' + names.length + ' charts)  ' + names.slice(0, 6).join(', ') + (names.length > 6 ? ' …' : ''));
const unresolved = rows.filter((r) => !r.ssrId);
if (unresolved.length) console.log('UNRESOLVED:', unresolved.map((r) => r.name).join(', '));
writeFileSync(join(ADMIN, '_extract', 'CHARTS_WORKLIST.json'), JSON.stringify(rows, null, 0));
