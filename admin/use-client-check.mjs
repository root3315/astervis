import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// App Router: a file using client-only hooks/APIs must have "use client" (or be part of a
// client subtree). Flag files using client hooks WITHOUT a "use client" directive that are
// NOT plainly server components (route handlers / async server pages-layouts with no hooks).
const ADMIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'reconstructed', 'admin');
const CLIENT_HOOKS = /\b(useState|useEffect|useLayoutEffect|useReducer|useRef|useContext|useCallback|useMemo|useId|useTransition|useDeferredValue|useSyncExternalStore|useRouter|usePathname|useSearchParams|useForm|useFormContext|useQuery|useMutation|useQueryClient|useInfiniteQuery|useTheme|useTranslations|useChat)\b/;
const ZUSTAND = /\buse[A-Z]\w*(Store|State|Filter)\b/;

function walk(d, a = []) {
  for (const e of readdirSync(d)) {
    if (['node_modules', '_extract', '.next'].includes(e)) continue;
    const p = join(d, e); const s = statSync(p);
    if (s.isDirectory()) walk(p, a); else if (/\.(ts|tsx)$/.test(e)) a.push(p);
  }
  return a;
}
const files = walk(ADMIN).filter((f) => f.includes(`${join('reconstructed','admin','app')}`) || f.includes(`${join('reconstructed','admin','components')}`) || f.includes(`${join('reconstructed','admin','hooks')}`));
const flagged = [];
for (const f of files) {
  const rel = relative(ADMIN, f).replace(/\\/g, '/');
  if (rel.includes('/api/') || rel.endsWith('route.ts')) continue;     // route handlers: server
  const src = readFileSync(f, 'utf8');
  const head = src.slice(0, 200);
  const hasDirective = /^\s*["']use client["']/.test(src) || /^﻿?\s*\/\/[^\n]*\n\s*["']use client["']/.test(src) || head.includes('"use client"') || head.includes("'use client'");
  const usesClient = CLIENT_HOOKS.test(src) || ZUSTAND.test(src) || /\bon[A-Z]\w+=\{/.test(src);
  // next-intl useTranslations works in server components too; require another client signal
  const strongClient = /\b(useState|useEffect|useRef|useReducer|useCallback|useMemo|useRouter|usePathname|useSearchParams|useForm|useQuery|useMutation|useTheme|useChat)\b/.test(src) || ZUSTAND.test(src) || /\bon(Click|Change|Submit|Input|KeyDown|Focus|Blur)=\{/.test(src);
  if (usesClient && strongClient && !hasDirective) flagged.push(rel);
}
console.log(`[use-client] scanned=${files.length} missing-directive=${flagged.length}`);
flagged.slice(0, 80).forEach((f) => console.log('  ! ' + f));
