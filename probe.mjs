import { readFileSync } from 'node:fs';
import * as acorn from 'acorn';

const file = process.argv[2];
const src = readFileSync(file, 'utf8');
console.error(`[probe] file=${file} bytes=${src.length}`);

const t0 = Date.now();
const ast = acorn.parse(src, {
  ecmaVersion: 'latest',
  sourceType: 'module',
  allowReturnOutsideFunction: true,
  allowAwaitOutsideFunction: true,
  allowSuperOutsideMethod: true,
});
console.error(`[probe] parsed in ${Date.now() - t0}ms, top-level stmts=${ast.body.length}`);

// Detect module wrappers: var X = __esm(...) / __commonJS(...)
function calleeName(node) {
  if (node?.type === 'CallExpression' && node.callee?.type === 'Identifier') return node.callee.name;
  return null;
}

let esm = 0, cjs = 0, bareVar = 0, other = 0;
const kinds = {};
const sampleNames = [];
for (const stmt of ast.body) {
  if (stmt.type === 'VariableDeclaration') {
    let matched = false;
    for (const d of stmt.declarations) {
      const cn = calleeName(d.init);
      if (cn === '__esm') { esm++; matched = true; sampleNames.push(['esm', d.id.name]); }
      else if (cn === '__commonJS') { cjs++; matched = true; sampleNames.push(['cjs', d.id.name]); }
    }
    if (!matched) {
      // bare var decl (possibly module export bindings) or other assignment
      const anyInit = stmt.declarations.some(d => d.init);
      if (!anyInit) bareVar++;
      else other++;
    }
  } else {
    kinds[stmt.type] = (kinds[stmt.type] || 0) + 1;
    other++;
  }
}
console.error(`[probe] esm=${esm} cjs=${cjs} bareVarDecls=${bareVar} otherTopLevel=${other}`);
console.error(`[probe] other stmt kinds:`, JSON.stringify(kinds));
console.error(`[probe] first 8 module names:`, JSON.stringify(sampleNames.slice(0, 8)));
console.error(`[probe] last 12 module names:`, JSON.stringify(sampleNames.slice(-12)));
