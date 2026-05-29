import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as acorn from 'acorn';

// Integrity check: every app/*.js must (a) start with a /** header, (b) parse without syntax errors
// once the header is stripped (i.e. the doc agents only prepended a comment, not broke code).
function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (e.endsWith('.js')) acc.push(p);
  }
  return acc;
}

let ok = 0, noHeader = 0, parseErr = 0, errs = [];
for (const svc of ['backend', 'queue', 'replication', 'sync_schedules']) {
  const files = walk(join('reconstructed', svc, 'app'));
  for (const f of files) {
    const code = readFileSync(f, 'utf8');
    const hasHeader = /^\s*\/\*\*/.test(code);
    if (!hasHeader) noHeader++;
    // strip leading block comment then parse as script
    const body = code.replace(/^\s*\/\*\*[\s\S]*?\*\/\s*/, '');
    try {
      acorn.parse(body, { ecmaVersion: 'latest', sourceType: 'script',
        allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowSuperOutsideMethod: true });
      ok++;
    } catch (e) {
      // retry as module (some files are ESM exports)
      try {
        acorn.parse(body, { ecmaVersion: 'latest', sourceType: 'module',
          allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowSuperOutsideMethod: true });
        ok++;
      } catch (e2) {
        parseErr++; errs.push(`${f}: ${e2.message}`);
      }
    }
  }
}
console.log(`[verify] parsedOK=${ok} parseErrors=${parseErr} missingHeader=${noHeader}`);
if (errs.length) { console.log('--- parse errors ---'); errs.slice(0, 40).forEach(e => console.log('  ' + e)); }
