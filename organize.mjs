import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import prettier from 'prettier';

// Build final app/<category>/ tree from the indexed manifest. Deterministic categorization.
// Usage: node organize.mjs <outDir>
const outDir = process.argv[2];
const manifest = JSON.parse(readFileSync(join(outDir, 'MANIFEST.json'), 'utf8'));
const src = readFileSync(join(outDir, '_payload.js'), 'utf8');

const VENDORMARK = /-lua|-drizzle-internal|-typebox|-vendor-class/;
const DENY = new Set(['createInternalAdapter', 'createAdapterFactory', 'memoryAdapter', 'drizzleAdapter',
  'getAuthTables', 'sessionSchema', 'createAdapter', 'getAdapter', 'html', 'cors', 'staticPlugin',
  'composeGeneralHandler', 'composeErrorHandler', 'createDynamicHandler', 'createDynamicErrorHandler',
  'createStreamHandler', 'createResponseHandler', 'createStaticHandler', 'createStaticHandler2',
  'createOnRequestHandler', 'createBunRouteHandler', 'createNativeStaticHandler', 'supportPerMethodInlineHandler',
  'attachRedisErrorHandler', 'ZipHandler', 'createWSMessageParser', 'handleElysiaFile', 'handleUnion',
  'CloudflareAdapter', 'apple', 'signInSocial', 'requestPasswordReset', 'createAuthEndpoint']);

function isApp(u) {
  if (DENY.has(u.name)) return false;
  if (/^require_/.test(u.name)) return false;
  if (u.isModuleWrapper) return u.domainHits.length >= 6;            // the DB schema module
  if (u.why.some(w => VENDORMARK.test(w))) return false;
  if (u.score >= 6) return true;
  if (u.domainHits.length >= 2) return true;
  return false;
}

const has = (u, ...words) => words.some(w => u.domainHits.includes(w));
const nm = (u, re) => re.test(u.name);
const sn = (u, re) => re.test(u.snippet);

function categorize(u) {
  if (u.isModuleWrapper && u.domainHits.length >= 6) return ['db', 'schema'];
  if (sn(u, /__export\(exports_schema/)) return ['db', 'schema'];
  // Elysia route controllers
  if (nm(u, /Controller\d*$/) || (u.routeCount > 0 && sn(u, /new Elysia/))) {
    if (nm(u, /^api(Controller)?$/)) return ['', 'app'];            // aggregator
    return ['routes', null];
  }
  if (nm(u, /^(ctx|diagnosticsPlugin)$/)) return ['routes', '_plugins'];
  // services / clients
  if (nm(u, /(Service|ApiClient|Repository|Provider|Manager)\d*$/) || sn(u, /^\s*class\s+\w+[^{]*\{\s*(drizzle|redis)\b/)) {
    if (has(u, 'amocrm') || nm(u, /AmoCRM|Amocrm/)) return ['integrations/amocrm', null];
    if (has(u, 'bitrix24') || nm(u, /Bitrix/)) return ['integrations/bitrix24', null];
    if (has(u, 'whatsapp') || nm(u, /Whatsapp|WhatsApp/)) return ['integrations/whatsapp', null];
    if (has(u, 'ari', 'ami', 'asterisk') || nm(u, /^A[rm]iService|Asterisk/)) return ['integrations/asterisk', null];
    return ['services', null];
  }
  // licensing
  if (has(u, 'license') || nm(u, /[Ll]icense|fetchPublicKey|fetchTokenFromAgent|refreshToken|getAIGatewayJwt|DemoMode|OperatorLimits|canCreateOperator|getAgentUsage|phoneHome/)) return ['licensing', null];
  // AI / transcripts / QA
  if (has(u, 'transcri', 'llm', 'embedding', 'rubric', 'qa_') || nm(u, /[Rr]ag|[Tt]ranscript|[Rr]ubric|[Ee]mbed|[Cc]opilot|[Ii]nsight|Analyz|metricLabel|tableTitle|hybridSearch|formatRag|evaluatePhrase|rowToCall|QA_/)) return ['ai', null];
  // openlines (telegram / whatsapp chat platform)
  if (has(u, 'telegram', 'whatsapp', 'openline', 'channel') || nm(u, /[Tt]elegram|[Ww]hatsApp|[Ww]hatsapp|Webhook|Onboarding|Channel|QuickRepl|setupTelegram|enqueue|ctxFor|getDefaultQueue|sendOnboarding/)) return ['openlines', null];
  // integrations by domain
  if (has(u, 'bitrix24') || nm(u, /[Bb]itrix/)) return ['integrations/bitrix24', null];
  if (has(u, 'amocrm') || nm(u, /[Aa]mocrm|AmoCRM/)) return ['integrations/amocrm', null];
  if (has(u, 'ari', 'ami', 'asterisk') || nm(u, /[Aa]sterisk|getAriService|getAmiService/)) return ['integrations/asterisk', null];
  // typebox schemas
  if (nm(u, /\w+Schema\d*$/)) return ['schemas', null];
  // job processors / workers
  if (sn(u, /async function process[A-Z]/) || nm(u, /^process[A-Z]|Worker$/)) return ['workers', null];
  // bootstrap / entry
  if (u.kind === 'ExpressionStatement' || nm(u, /^(app|main|cleanup)$/)) return ['entry', null];
  return ['util', null];
}

const appUnits = manifest.units.filter(isApp);
const used = new Map();
const fname = (name) => { let b = (name || 'unit').replace(/[^A-Za-z0-9_$.-]/g, '_').slice(0, 70);
  if (/^(ExpressionStatement|anon)/.test(b)) b = b.replace(/_\d+$/, '');
  const n = (used.get(b) || 0) + 1; used.set(b, n); return n === 1 ? b : `${b}__${n}`; };

async function pretty(code) {
  try { return await prettier.format(code, { parser: 'babel', printWidth: 100, semi: true, singleQuote: false }); }
  catch { return code; }
}

const appIndex = [];
for (const u of appUnits) {
  let [dir, forceName] = categorize(u);
  const sub = join(outDir, 'app', dir);
  mkdirSync(sub, { recursive: true });
  const base = forceName || u.name;
  const fn = fname(base) + '.js';
  const code = await pretty(src.slice(u.start, u.end));
  writeFileSync(join(sub, fn), code);
  appIndex.push({ index: u.index, name: u.name, category: dir || 'app', file: join('app', dir, fn).replace(/\\/g, '/'),
    kind: u.kind, bytes: u.bytes, routeCount: u.routeCount, routes: u.routes, domainHits: u.domainHits, snippet: u.snippet });
}

// group counts
const byCat = {};
for (const a of appIndex) byCat[a.category] = (byCat[a.category] || 0) + 1;

writeFileSync(join(outDir, 'APP_INDEX.json'), JSON.stringify({ file: manifest.file, appCount: appIndex.length, byCategory: byCat, units: appIndex }, null, 1));

// ---- ROUTES.md (deterministic endpoint map) ----
const controllers = appIndex.filter(a => a.routeCount > 0).sort((a, b) => b.routeCount - a.routeCount);
let md = `# API Routes — ${manifest.file}\n\nTotal endpoints: ${controllers.reduce((s, c) => s + c.routeCount, 0)} across ${controllers.length} controllers.\n\n`;
for (const c of controllers) {
  md += `## ${c.name} (${c.routeCount})\n\n\`${c.file}\`\n\n`;
  for (const r of c.routes) md += `- \`${r}\`\n`;
  md += `\n`;
}
if (controllers.length) writeFileSync(join(outDir, 'ROUTES.md'), md);

console.error(`[organize] ${manifest.file}: app units=${appIndex.length} categories=${JSON.stringify(byCat)}`);
console.error(`[organize] wrote app/, APP_INDEX.json${controllers.length ? ', ROUTES.md' : ''}`);
