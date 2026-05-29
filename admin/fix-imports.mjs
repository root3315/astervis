import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Normalize dangling "@/..." imports across the reconstructed admin by matching
// the imported symbols to the file that actually exports them. Parallel decompile
// agents guess different paths for the same shared module; this repoints them.
// Usage: node tools/admin/fix-imports.mjs [--dry]

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN = join(__dirname, '..', '..', 'reconstructed', 'admin');
const DRY = process.argv.includes('--dry');

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '_extract' || e === '.next') continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e)) acc.push(p);
  }
  return acc;
}

const files = walk(ADMIN);

// ---- 1. build symbol -> [files] and default-export basenames ----
const symbolToFiles = new Map();   // exported name -> Set(absFile)
const add = (name, f) => { if (!symbolToFiles.has(name)) symbolToFiles.set(name, new Set()); symbolToFiles.get(name).add(f); };

const EXPORT_RES = [
  /export\s+(?:async\s+)?(?:const|let|var|function|class)\s+([A-Za-z0-9_$]+)/g,
  /export\s+(?:type|interface|enum)\s+([A-Za-z0-9_$]+)/g,
];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const re of EXPORT_RES) { let m; re.lastIndex = 0; while ((m = re.exec(src))) add(m[1], f); }
  // export { A, B as C }
  let m; const re = /export\s*\{([^}]+)\}(?!\s*from)/g;
  while ((m = re.exec(src))) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name) add(name, f);
    }
  }
}

const aliasToAbs = (spec) => join(ADMIN, spec.replace(/^@\//, ''));
const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];
const resolves = (spec) => EXTS.some((e) => existsSync(aliasToAbs(spec) + e));
const toAlias = (absFile) => '@/' + relative(ADMIN, absFile).replace(/\\/g, '/').replace(/\.(ts|tsx)$/, '');

// ---- 2. rewrite dangling "@/" imports ----
const IMPORT_RE = /import\s+(type\s+)?([^;'"]*?)\s+from\s*["'](@\/[^"']+)["']/g;
function parseClause(clause) {
  const names = [];
  const braced = clause.match(/\{([^}]*)\}/);
  if (braced) for (const p of braced[1].split(',')) { const n = p.trim().split(/\s+as\s+/)[0].trim().replace(/^type\s+/, ''); if (n) names.push(n); }
  const head = clause.replace(/\{[^}]*\}/, '').replace(/\*\s+as\s+[A-Za-z0-9_$]+/, '').replace(/,/g, '').trim();
  const def = head && /^[A-Za-z0-9_$]+$/.test(head) ? head : null;
  return { names, def };
}

let rewrites = 0, unresolved = [];
for (const f of files) {
  let src = readFileSync(f, 'utf8');
  let changed = false;
  src = src.replace(IMPORT_RE, (full, typeKw, clause, spec) => {
    if (resolves(spec)) return full;
    const { names, def } = parseClause(clause);
    // candidate files = intersection of exporters of each named symbol
    let cand = null;
    for (const n of names) {
      const set = symbolToFiles.get(n);
      if (!set) { cand = null; break; }
      cand = cand ? new Set([...cand].filter((x) => set.has(x))) : new Set(set);
    }
    let target = null;
    if (cand && cand.size === 1) target = [...cand][0];
    else if (cand && cand.size > 1) {
      // prefer the candidate whose path looks closest to the requested spec
      const want = spec.toLowerCase();
      target = [...cand].sort((a, b) =>
        scorePath(b, want) - scorePath(a, want))[0];
    }
    if (!target && def && names.length === 0) {
      // default-only import: match by basename (kebab/pascal-insensitive)
      const base = spec.split('/').pop().replace(/[-_]/g, '').toLowerCase();
      const hit = files.find((x) => x.split(/[\\/]/).pop().replace(/\.(ts|tsx)$/, '').replace(/[-_]/g, '').toLowerCase() === base);
      if (hit) target = hit;
    }
    if (!target) { unresolved.push(`${relative(ADMIN, f)}: ${spec} {${names.join(',')}${def ? ' default:' + def : ''}}`); return full; }
    const newSpec = toAlias(target);
    if (newSpec === spec) return full;
    changed = true; rewrites++;
    return full.replace(spec, newSpec);
  });
  // dynamic imports: import("@/..") — no named symbols, repoint by file basename
  const DYN_RE = /import\(\s*["'](@\/[^"']+)["']\s*\)/g;
  src = src.replace(DYN_RE, (full, spec) => {
    if (resolves(spec)) return full;
    const base = spec.split('/').pop().replace(/[-_()]/g, '').toLowerCase();
    const hit = files.find((x) => x.split(/[\\/]/).pop().replace(/\.(ts|tsx)$/, '').replace(/[-_()]/g, '').toLowerCase() === base);
    if (!hit) { unresolved.push(`${relative(ADMIN, f)}: import(${spec})`); return full; }
    const newSpec = toAlias(hit);
    if (newSpec === spec) return full;
    changed = true; rewrites++;
    return full.replace(spec, newSpec);
  });
  if (changed && !DRY) writeFileSync(f, src);
}
function scorePath(absFile, wantLower) {
  const p = toAlias(absFile).toLowerCase();
  const a = p.split('/'), b = wantLower.split('/');
  let s = 0; for (const seg of b) if (a.includes(seg)) s++;
  return s;
}

console.log(`[fix-imports] files=${files.length} symbols=${symbolToFiles.size} rewrites=${rewrites}${DRY ? ' (dry-run)' : ''}`);
console.log(`[fix-imports] still-unresolved=${unresolved.length}`);
unresolved.slice(0, 50).forEach((u) => console.log('  ? ' + u));
