import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Group reconstructed files into review batches (skip standard shadcn ui — low risk).
const ADMIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reconstructed', 'admin');
function walk(d, a = []) {
  for (const e of readdirSync(d)) {
    if (['node_modules', '_extract', '.next'].includes(e)) continue;
    const p = join(d, e); const s = statSync(p);
    if (s.isDirectory()) walk(p, a); else if (/\.(ts|tsx)$/.test(e)) a.push(p);
  }
  return a;
}
const all = walk(ADMIN).map((f) => relative(ADMIN, f).replace(/\\/g, '/'));
// area classification
const area = (f) => f.startsWith('app/api/') ? 'api'
  : f.startsWith('components/ui/') ? 'ui'
  : f.startsWith('components/charts/') ? 'charts'
  : f.startsWith('app/') ? 'pages'
  : f.startsWith('components/') ? 'components'
  : f.startsWith('stores/') || f.startsWith('hooks/') || f.startsWith('lib/') ? 'shared'
  : 'other';
const groups = {};
for (const f of all) { const a = area(f); (groups[a] = groups[a] || []).push(f); }
// chunk each area into batches of ~9 (ui smaller batches less critical; skip ui from review)
const SIZE = { pages: 6, charts: 9, components: 8, shared: 8, api: 12, other: 10 };
const batches = [];
for (const [a, files] of Object.entries(groups)) {
  if (a === 'ui') continue;                       // standard shadcn — skip semantic review
  const n = SIZE[a] || 9;
  for (let i = 0; i < files.length; i += n) batches.push({ area: a, files: files.slice(i, i + n) });
}
batches.forEach((b, i) => (b.id = i + 1));
writeFileSync(join(ADMIN, '_extract', 'REVIEW_BATCHES.json'), JSON.stringify(batches, null, 0));
const byArea = {}; for (const b of batches) byArea[b.area] = (byArea[b.area] || 0) + 1;
console.log('total files:', all.length, '| ui skipped:', (groups.ui || []).length);
console.log('review batches:', batches.length, JSON.stringify(byArea));
