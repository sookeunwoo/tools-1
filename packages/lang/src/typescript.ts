/**
 * TypeScript/JavaScript 어휘 스캐너.
 *
 * JVM 쪽보다 얕다 — Next.js 라우트 규약과 최상위 함수/클래스만 본다.
 * 주력 대상이 Kotlin/Spring이라 여기는 의도적으로 얇게 유지한다 (P8).
 */

import { stripCode, lineAt, blockRange } from './lex.ts';
import type { Endpoint, FileSymbols, MethodSymbol, ScanGap, TypeSymbol } from './types.ts';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const CALL_RE = /(?:(\w+)\s*(?:\?\.|\.))?\b([a-z]\w*)\s*\(/g;
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'function', 'require']);

export function scanTypeScript(path: string, src: string, gaps: ScanGap[]): FileSymbols {
  const c = stripCode(src);
  const t = c.text;

  const imports = [...t.matchAll(/^\s*import\s+(?:[\s\S]*?from\s+)?['"]?([^'";\n]+)/gm)].map((m) => m[1].trim());
  const types: TypeSymbol[] = [];
  const endpoints: Endpoint[] = [];

  // class
  for (const m of t.matchAll(/\b(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/g)) {
    const declStart = m.index!;
    const body = blockRange(t, declStart + m[0].length);
    if (!body) {
      gaps.push({ path, line: lineAt(t, declStart), reason: 'type-body-not-found', detail: m[1] });
      continue;
    }
    types.push({
      name: m[1],
      kind: 'class',
      line: lineAt(t, declStart),
      annotations: [],
      supertypes: m[2] ? [m[2]] : [],
      fields: parseFields(t, body),
      methods: parseClassMethods(t, body),
    });
  }

  // 최상위 함수 — 모듈 이름을 타입처럼 취급해 호출 그래프에 올린다
  const moduleName = moduleNameOf(path);
  const fns: MethodSymbol[] = [];
  for (const m of t.matchAll(/\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)\s*\(/g)) {
    const range = blockRange(t, m.index! + m[0].length);
    fns.push(mkMethod(t, m[1], m.index!, range));
  }
  for (const m of t.matchAll(/\b(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?\([^)]*\)\s*=>/g)) {
    const range = blockRange(t, m.index! + m[0].length);
    fns.push(mkMethod(t, m[1], m.index!, range));
  }
  if (fns.length > 0) {
    types.push({ name: moduleName, kind: 'object', line: 1, annotations: [], supertypes: [], fields: [], methods: fns });
  }

  // Next.js App Router: app/**/route.ts 에서 export한 HTTP 메서드
  if (/(^|\/)route\.(ts|js|tsx|jsx)$/.test(path)) {
    const route = '/' + path.replace(/^.*?app\//, '').replace(/\/route\.\w+$/, '').replace(/\((\w+)\)\//g, '');
    for (const verb of HTTP_METHODS) {
      const fn = fns.find((f) => f.name === verb);
      if (fn) endpoints.push({ key: `${verb} ${route}`, kind: 'http', typeName: moduleName, methodName: verb, line: fn.line });
    }
  }

  return { path, lang: 'typescript', packageName: null, imports, types, endpoints };
}

function mkMethod(t: string, name: string, declStart: number, range: { start: number; end: number } | null): MethodSymbol {
  return {
    name,
    line: lineAt(t, declStart),
    bodyStart: range?.start ?? declStart,
    bodyEnd: range?.end ?? declStart,
    annotations: [],
    calls: range ? parseCalls(t, range.start, range.end) : [],
  };
}

function parseClassMethods(t: string, body: { start: number; end: number }): MethodSymbol[] {
  const region = t.slice(body.start, body.end);
  const out: MethodSymbol[] = [];
  for (const m of region.matchAll(/(?:^|\n)\s*(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::[^{;]+)?\{/g)) {
    const declStart = body.start + m.index! + m[0].indexOf(m[1]);
    if (KEYWORDS.has(m[1])) continue;
    const range = blockRange(t, body.start + m.index! + m[0].length - 1);
    out.push(mkMethod(t, m[1], declStart, range));
  }
  return out;
}

function parseFields(t: string, body: { start: number; end: number }): TypeSymbol['fields'] {
  const region = t.slice(body.start, body.end);
  const out: TypeSymbol['fields'] = [];
  for (const m of region.matchAll(/(?:private|public|protected|readonly)\s+(\w+)\s*:\s*([A-Z]\w*)/g)) {
    out.push({ name: m[1], type: m[2], line: lineAt(t, body.start + m.index!) });
  }
  return out;
}

function parseCalls(t: string, from: number, to: number) {
  const region = t.slice(from, to);
  const calls = [];
  for (const m of region.matchAll(CALL_RE)) {
    if (KEYWORDS.has(m[2])) continue;
    calls.push({ receiver: m[1] && !KEYWORDS.has(m[1]) ? m[1] : null, method: m[2], line: lineAt(t, from + m.index!) });
  }
  return calls;
}

function moduleNameOf(path: string): string {
  return path.replace(/\.\w+$/, '').split('/').slice(-2).join('/');
}
