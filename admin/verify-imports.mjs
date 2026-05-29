import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Buildability check for reconstructed/admin: report (a) dangling "@/..." imports and
// (b) bare/vendor imports whose package is NOT in package.json (would break install/build).
// Usage: node tools/admin/verify-imports.mjs

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN = join(__dirname, '..', '..', 'reconstructed', 'admin');

const pkg = JSON.parse(readFileSync(join(ADMIN, 'package.json'), 'utf8'));
const deps = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
// node builtins + always-available
const BUILTIN = new Set(['react', 'react-dom', 'next', 'node:fs', 'node:path', 'node:url', 'fs', 'path', 'crypto', 'stream', 'util', 'os', 'events', 'buffer']);

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '_extract' || e === '.next') continue;
    const p = join(dir, e); const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (/\.(ts|tsx)$/.test(e)) acc.push(p);
  }
  return acc;
}
const files = walk(ADMIN);
const EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx'];
const aliasResolves = (spec) => EXTS.some((e) => existsSync(join(ADMIN, spec.replace(/^@\//, '')) + e));
// package name from a bare specifier (handle @scope/pkg and subpaths)
const pkgName = (spec) => {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
};

const danglingAlias = {}, missingVendor = {};
const IMPORT_RE = /(?:import|export)\s+[^;]*?\s+from\s*["']([^"']+)["']|import\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
for (const f of files) {
  const src = readFileSync(f, 'utf8'); let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) {
    const spec = m[1] || m[2] || m[3];
    if (!spec) continue;
    if (spec.startsWith('@/')) { if (!aliasResolves(spec)) (danglingAlias[spec] = danglingAlias[spec] || 0, danglingAlias[spec]++); }
    else if (spec.startsWith('.') || spec.startsWith('/')) { /* relative — skip */ }
    else {
      const name = pkgName(spec);
      if (!deps.has(name) && !BUILTIN.has(name) && !name.startsWith('node:')) (missingVendor[name] = missingVendor[name] || 0, missingVendor[name]++);
    }
  }
}
const da = Object.entries(danglingAlias).sort((a, b) => b[1] - a[1]);
const mv = Object.entries(missingVendor).sort((a, b) => b[1] - a[1]);
console.log(`[verify] files=${files.length}`);
console.log(`[verify] dangling @/ imports: ${da.length}`);
da.slice(0, 40).forEach(([s, n]) => console.log(`   @/ ${s}  (${n})`));
console.log(`[verify] vendor imports NOT in package.json: ${mv.length}`);
mv.slice(0, 40).forEach(([s, n]) => console.log(`   pkg ${s}  (${n})`));
