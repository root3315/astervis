import { readFileSync } from 'node:fs';
import * as acorn from 'acorn';

const file = process.argv[2];
const raw = readFileSync(file);
let cut = raw.indexOf(0x00); if (cut < 0) cut = raw.length;
const src = raw.slice(0, cut).toString('utf8');
const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module',
  allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowSuperOutsideMethod: true, locations: true });

function calleeName(node){ return node?.type==='CallExpression'&&node.callee?.type==='Identifier'?node.callee.name:null; }
function isModuleWrapper(stmt){
  if(stmt.type!=='VariableDeclaration')return false;
  return stmt.declarations.some(d=>{const c=calleeName(d.init);return c==='__esm'||c==='__commonJS';});
}

// Categorize top-level statements
const cats = {};
const appUnits = [];
for (const stmt of ast.body){
  if (isModuleWrapper(stmt)) { cats.moduleWrapper=(cats.moduleWrapper||0)+1; continue; }
  const slice = src.slice(stmt.start, stmt.end);
  const bytes = slice.length;
  let label = stmt.type;
  // name extraction
  let name = null;
  if (stmt.type==='VariableDeclaration' && stmt.declarations[0]?.id?.type==='Identifier') name=stmt.declarations[0].id.name;
  if (stmt.type==='FunctionDeclaration') name=stmt.id?.name;
  if (stmt.type==='ClassDeclaration') name=stmt.id?.name;
  const hasElysia = /new Elysia\b/.test(slice);
  const routeCount = (slice.match(/\.(get|post|put|delete|patch)\(\s*["'`]\//g)||[]).length;
  cats[label]=(cats[label]||0)+1;
  if (hasElysia || routeCount>0 || bytes>2000){
    appUnits.push({type:stmt.type,name,bytes,hasElysia,routeCount,
      startLine:stmt.loc.start.line, snippet:slice.slice(0,90).replace(/\s+/g,' ')});
  }
}
console.error('[toplevel] category counts:', JSON.stringify(cats,null,1));
console.error('[toplevel] big/app units:', appUnits.length);
const big = appUnits.sort((a,b)=>b.bytes-a.bytes);
console.error('--- TOP 40 by size ---');
for(const u of big.slice(0,40)) console.error(`  ${u.type} ${u.name||'(anon)'} bytes=${u.bytes} elysia=${u.hasElysia} routes=${u.routeCount} L${u.startLine} :: ${u.snippet}`);
console.error('--- ELYSIA units ---');
for(const u of appUnits.filter(u=>u.hasElysia).sort((a,b)=>b.routeCount-a.routeCount)) console.error(`  ${u.name||'(anon)'} routes=${u.routeCount} bytes=${u.bytes} L${u.startLine} :: ${u.snippet}`);
