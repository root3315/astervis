import { readFileSync, writeFileSync } from 'node:fs';

// Build a grouped doc-task list from the per-bundle APP_INDEX.json files.
const bundles = ['backend', 'queue', 'replication', 'sync_schedules'];
const tasks = [];
let id = 0;

for (const b of bundles) {
  let idx;
  try { idx = JSON.parse(readFileSync(`reconstructed/${b}/APP_INDEX.json`, 'utf8')); }
  catch { continue; }
  // group by category
  const byCat = {};
  for (const u of idx.units) (byCat[u.category] ||= []).push(u);
  for (const [cat, units] of Object.entries(byCat)) {
    const mkFiles = (arr) => arr.map(u => ({ path: `reconstructed/${b}/${u.file}`, name: u.name, bytes: u.bytes, routeCount: u.routeCount }));
    // chunk big categories
    let chunkSize = cat === 'db' ? 1 : (cat === 'routes' ? 6 : 12);
    for (let i = 0; i < units.length; i += chunkSize) {
      const slice = units.slice(i, i + chunkSize);
      tasks.push({
        id: `t${id++}`,
        bundle: b,
        category: cat,
        title: `${b}/${cat}${units.length > chunkSize ? ` [${i / chunkSize + 1}]` : ''}`,
        readmeDir: `reconstructed/${b}/app/${cat}`,
        writeReadme: i === 0,        // only first chunk writes the category README
        files: mkFiles(slice),
      });
    }
  }
}

writeFileSync('tools/doctasks.json', JSON.stringify(tasks, null, 1));
console.error(`[doctasks] ${tasks.length} doc tasks across ${bundles.length} bundles, ${tasks.reduce((s, t) => s + t.files.length, 0)} files`);
for (const b of bundles) {
  const bt = tasks.filter(t => t.bundle === b);
  console.error(`  ${b}: ${bt.length} tasks`);
}
