import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Write the inlined-vendor leftover units (non-module, non-app top-level code) so the
// split is lossless. Mirrors organize.mjs's isApp() so nothing falls between the cracks.
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
  if (u.isModuleWrapper) return u.domainHits.length >= 6;
  if (u.why.some(w => VENDORMARK.test(w))) return false;
  if (u.score >= 6) return true;
  if (u.domainHits.length >= 2) return true;
  return false;
}

const inlined = manifest.units.filter(u => !u.isModuleWrapper && !isApp(u));
mkdirSync(join(outDir, 'vendor/inlined'), { recursive: true });

let chunk = [], names = [], bytes = 0, idx = 0;
const flush = () => {
  if (!chunk.length) return;
  const fn = `inlined_${String(idx).padStart(3, '0')}.js`;
  const header = `/* Astervis reconstructed — inlined vendor/runtime code (minified, untouched).\n   Units in this chunk: ${names.join(', ')} */\n\n`;
  writeFileSync(join(outDir, 'vendor/inlined', fn), header + chunk.join('\n\n'));
  idx++; chunk = []; names = []; bytes = 0;
};
for (const u of inlined) {
  chunk.push(`/* ${u.name} */\n${src.slice(u.start, u.end)}`);
  names.push(u.name); bytes += u.bytes;
  if (bytes > 500_000) flush();
}
flush();
console.error(`[vendor_inlined] ${manifest.file}: ${inlined.length} inlined-vendor units -> ${idx} chunks`);
