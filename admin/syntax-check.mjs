import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Pure-syntax parse of every reconstructed TS/TSX file via the TypeScript parser
// (no type-check, no node_modules needed). Reports syntax errors = decompilation bugs.
const require = createRequire(import.meta.url);
const ts = require('typescript');
const ADMIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reconstructed', 'admin');

function walk(d, a = []) {
  for (const e of readdirSync(d)) {
    if (['node_modules', '_extract', '.next'].includes(e)) continue;
    const p = join(d, e); const s = statSync(p);
    if (s.isDirectory()) walk(p, a); else if (/\.(ts|tsx)$/.test(e)) a.push(p);
  }
  return a;
}
const files = walk(ADMIN);
let ok = 0; const bad = [];
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const kind = f.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.ES2022, true, kind);
  const diags = sf.parseDiagnostics || [];
  if (diags.length === 0) { ok++; continue; }
  const msgs = diags.slice(0, 3).map((d) => {
    const pos = d.start != null ? sf.getLineAndCharacterOfPosition(d.start) : { line: 0, character: 0 };
    return `L${pos.line + 1}:${pos.character + 1} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
  });
  bad.push({ file: relative(ADMIN, f), n: diags.length, msgs });
}
console.log(`[syntax] files=${files.length} ok=${ok} withSyntaxErrors=${bad.length}`);
for (const b of bad) { console.log(`\n  x ${b.file} (${b.n})`); b.msgs.forEach((m) => console.log(`      ${m}`)); }
