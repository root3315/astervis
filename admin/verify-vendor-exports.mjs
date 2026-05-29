import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Verify every NAMED import from an installed vendor package actually exists in that
// package's runtime exports. Requires `pnpm install` to have run in reconstructed/admin.
// Skips type-only imports and packages that can't be imported in Node (browser/server-only).
const ADMIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reconstructed', 'admin');
const req = createRequire(join(ADMIN, 'package.json'));

function walk(d, a = []) {
  for (const e of readdirSync(d)) {
    if (['node_modules', '_extract', '.next'].includes(e)) continue;
    const p = join(d, e); const s = statSync(p);
    if (s.isDirectory()) walk(p, a); else if (/\.(ts|tsx)$/.test(e)) a.push(p);
  }
  return a;
}
const files = walk(ADMIN);
// pkg -> Map(name -> Set(files))
const wanted = new Map();
const IMPORT_RE = /import\s+(type\s+)?([^;'"]*?)\s+from\s*["']([^"']+)["']/g;
for (const f of files) {
  const src = readFileSync(f, 'utf8'); let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) {
    const typeKw = m[1], clause = m[2], spec = m[3];
    if (typeKw) continue;                              // import type {...} — not runtime
    if (spec.startsWith('@/') || spec.startsWith('.') || spec.startsWith('/')) continue;
    const braced = clause.match(/\{([^}]*)\}/);
    if (!braced) continue;
    const names = braced[1].split(',')
      .map((p) => p.trim())
      .filter((p) => p && !p.startsWith('type '))      // skip inline type imports
      .map((p) => p.split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    if (!names.length) continue;
    if (!wanted.has(spec)) wanted.set(spec, new Map());
    const mp = wanted.get(spec);
    for (const n of names) { if (!mp.has(n)) mp.set(n, new Set()); mp.get(n).add(relative(ADMIN, f).replace(/\\/g, '/')); }
  }
}

const problems = [];
const unverifiable = [];
for (const [spec, mp] of wanted) {
  let mod;
  try {
    const resolved = req.resolve(spec);
    mod = await import(pathToFileURL(resolved).href);
  } catch (e) {
    unverifiable.push(`${spec} (${e.message.split('\n')[0].slice(0, 60)})`);
    continue;
  }
  const keys = new Set(Object.keys(mod));
  if (mod.default && typeof mod.default === 'object') for (const k of Object.keys(mod.default)) keys.add(k);
  for (const [name, fileset] of mp) {
    if (!keys.has(name)) problems.push({ spec, name, files: [...fileset] });
  }
}
console.log(`[vendor-exports] packages-checked=${wanted.size} missing-named-exports=${problems.length} unverifiable=${unverifiable.length}`);
for (const p of problems) console.log(`  ! "${p.name}" not exported by ${p.spec}  <- ${p.files.slice(0, 3).join(', ')}${p.files.length > 3 ? ' …' : ''}`);
if (unverifiable.length) console.log('\n  (could not import, skipped): ' + unverifiable.slice(0, 20).join('; '));
