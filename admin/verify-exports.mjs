import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Verify every NAMED "@/..." or relative import resolves to a symbol the target file
// actually exports (incl. `export *`/`export {x} from` re-exports). Catches the
// "imported a non-existent named export" build-breaker class. Usage: node tools/admin/verify-exports.mjs
const ADMIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reconstructed', 'admin');
const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];

function walk(d, a = []) {
  for (const e of readdirSync(d)) {
    if (['node_modules', '_extract', '.next'].includes(e)) continue;
    const p = join(d, e); const s = statSync(p);
    if (s.isDirectory()) walk(p, a); else if (/\.(ts|tsx)$/.test(e)) a.push(p);
  }
  return a;
}
const files = walk(ADMIN);
const resolveTo = (fromFile, spec) => {
  let baseDir;
  if (spec.startsWith('@/')) baseDir = ADMIN, spec = spec.slice(2);
  else if (spec.startsWith('.')) baseDir = dirname(fromFile);
  else return null;                       // bare/vendor — not checked here
  const base = baseDir === ADMIN ? join(ADMIN, spec) : resolve(baseDir, spec);
  for (const e of EXTS) if (existsSync(base + e) && statSync(base + e).isFile()) return base + e;
  return null;
};

// extract a file's own export NAMES + its re-export sources (paths)
const exportCache = new Map();
function ownExports(file) {
  if (exportCache.has(file)) return exportCache.get(file);
  const src = readFileSync(file, 'utf8');
  const names = new Set(); const reexportAll = []; let hasDefault = false;
  let m;
  for (const re of [/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g,
                    /export\s+(?:type|interface|enum)\s+([A-Za-z0-9_$]+)/g]) {
    re.lastIndex = 0; while ((m = re.exec(src))) names.add(m[1]);
  }
  // export { a, b as c } / export type { ... }  (optionally `from "..."`)
  const reBr = /export\s*(?:type\s+)?\{([^}]+)\}\s*(?:from\s*["']([^"']+)["'])?/g;
  while ((m = reBr.exec(src))) {
    for (const part of m[1].split(',')) { const n = part.trim().split(/\s+as\s+/).pop().trim(); if (n) names.add(n); }
  }
  // destructured export: export const { Link, useRouter } = ...  /  export const [a, b] = ...
  const reDestr = /export\s+(?:const|let|var)\s*[{[]([^}\]]+)[}\]]\s*=/g;
  while ((m = reDestr.exec(src))) {
    for (const part of m[1].split(',')) {
      // `a`, `a: b` (renamed -> local b), `a = default`
      const n = part.trim().split(':').pop().trim().split('=')[0].trim().replace(/^\.\.\./, '');
      if (n && /^[A-Za-z0-9_$]+$/.test(n)) names.add(n);
    }
  }
  // export * from "..."
  const reStar = /export\s*\*\s*(?:as\s+[A-Za-z0-9_$]+\s+)?from\s*["']([^"']+)["']/g;
  while ((m = reStar.exec(src))) reexportAll.push(m[1]);
  if (/export\s+default\b/.test(src)) hasDefault = true;
  const rec = { names, reexportAll, hasDefault };
  exportCache.set(file, rec);
  return rec;
}
// resolve full export set following re-exports (depth-limited)
function allExports(file, depth = 0, seen = new Set()) {
  if (!file || seen.has(file) || depth > 4) return new Set();
  seen.add(file);
  const rec = ownExports(file);
  const out = new Set(rec.names);
  for (const spec of rec.reexportAll) {
    const tgt = resolveTo(file, spec);
    if (tgt) for (const n of allExports(tgt, depth + 1, seen)) out.add(n);
  }
  return out;
}

const IMPORT_RE = /import\s+(?:type\s+)?([^;'"]*?)\s+from\s*["']([^"']+)["']/g;
const problems = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8'); let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) {
    const clause = m[1], spec = m[2];
    if (!(spec.startsWith('@/') || spec.startsWith('.'))) continue;
    const braced = clause.match(/\{([^}]*)\}/);
    if (!braced) continue;                // default/namespace only — skip
    const names = braced[1].split(',').map((p) => p.trim().split(/\s+as\s+/)[0].trim().replace(/^type\s+/, '')).filter(Boolean);
    if (!names.length) continue;
    const tgt = resolveTo(f, spec);
    if (!tgt) continue;                   // path-resolution handled by verify-imports
    const exp = allExports(tgt);
    const missing = names.filter((n) => !exp.has(n));
    if (missing.length) problems.push({ file: relative(ADMIN, f).replace(/\\/g, '/'), spec, missing });
  }
}
console.log(`[verify-exports] files=${files.length} import-sites-with-missing-named-exports=${problems.length}`);
for (const p of problems.slice(0, 60)) console.log(`  ! ${p.file}\n      {${p.missing.join(', ')}} not exported by ${p.spec}`);
