/**
 * Kotlin/Java 어휘 스캐너.
 *
 * 정확도 전략(ADR-002 1단계): 타입 추론을 하지 않는다.
 * **선언된 타입명 + 메서드명**만 보고 호출을 해석하고, 확신이 없으면 gap으로 남긴다.
 * 조용히 틀린 답이 "모르겠다"보다 나쁘다 (설계원칙 P9).
 */

import { stripCode, lineAt, blockRange, annotationsBefore, annotationArg, type Cleaned } from './lex.ts';
import type { Annotation, CallSite, DiField, Endpoint, FileSymbols, Lang, MethodSymbol, ScanGap, TypeSymbol } from './types.ts';

const TYPE_RE = /\b(?:data\s+|sealed\s+|abstract\s+|open\s+|final\s+|static\s+|public\s+|private\s+|internal\s+)*(class|interface|object|enum\s+class|enum|@interface)\s+([A-Z]\w*)/g;
const KT_FUN_RE = /\bfun\s+(?:<[^>]+>\s*)?(?:[\w.]+\.)?(\w+)\s*\(/g;
const JAVA_METHOD_RE = /\b(?:public|private|protected)\s+(?:static\s+|final\s+|synchronized\s+)*[\w<>\[\],.?\s]+\s+(\w+)\s*\([^;{]*\)\s*(?:throws[\w\s,.]+)?\{/g;
const CALL_RE = /(?:(\w+)\s*(?:\?\.|\.))?\b([a-z]\w*)\s*\(/g;

/** 호출로 세면 안 되는 제어 구문. */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'when', 'switch', 'catch', 'return', 'super', 'this',
  'synchronized', 'try', 'do', 'else', 'assert', 'throw', 'new', 'fun', 'val', 'var',
]);

export function scanJvm(path: string, src: string, lang: Lang, gaps: ScanGap[]): FileSymbols {
  const c = stripCode(src);
  const t = c.text;

  const packageName = t.match(/^\s*package\s+([\w.]+)/m)?.[1] ?? null;
  const imports = [...t.matchAll(/^\s*import\s+(?:static\s+)?([\w.*]+)/gm)].map((m) => m[1]);

  const types: TypeSymbol[] = [];
  const endpoints: Endpoint[] = [];

  for (const m of t.matchAll(TYPE_RE)) {
    const declStart = m.index!;
    const name = m[2];
    const body = blockRange(t, declStart + m[0].length);
    const headEnd = body ? body.start : declEnd(t, declStart);

    const type: TypeSymbol = {
      name,
      kind: normalizeKind(m[1]),
      line: lineAt(t, declStart),
      annotations: annotationsBefore(c, declStart),
      supertypes: parseSupertypes(t.slice(declStart, headEnd)),
      fields: body ? parseDiFields(t, declStart, body) : [],
      methods: body ? parseMethods(path, c, body, lang, gaps) : [],
    };

    // 본문 없는 선언(`class Order`, 마커 인터페이스)도 인덱스에 남긴다.
    // @Entity/@Table 정보와 구현 관계가 여기 있어서, 빼면 테이블명·구현체 조회가 깨진다.
    if (!body) gaps.push({ path, line: type.line, reason: 'type-body-absent', detail: name });

    types.push(type);
    endpoints.push(...detectEndpoints(type, c));
  }

  if (types.length === 0 && /\b(class|interface|object)\b/.test(t)) {
    gaps.push({ path, line: 1, reason: 'no-type-parsed', detail: '타입 선언이 있는데 하나도 읽지 못했습니다' });
  }

  return { path, lang, packageName, imports, types, endpoints };
}

/** 본문 없는 선언의 끝 — 줄 끝 또는 `;`. 상위타입 파싱 구간을 정한다. */
function declEnd(t: string, declStart: number): number {
  const nl = t.indexOf('\n', declStart);
  const sc = t.indexOf(';', declStart);
  const cands = [nl, sc].filter((x) => x !== -1);
  return cands.length ? Math.min(...cands) : t.length;
}

function normalizeKind(raw: string): TypeSymbol['kind'] {
  if (raw.startsWith('enum')) return 'enum';
  if (raw === '@interface') return 'annotation';
  return raw as TypeSymbol['kind'];
}

/**
 * `class Foo : Bar(), Baz` / `class Foo extends Bar implements Baz`
 *
 * 주의: Kotlin 주 생성자를 반드시 건너뛰어야 한다.
 * `class Foo(private val bar: Bar)` 에서 Bar는 상위타입이 **아니라 DI 필드**다.
 * 이걸 상위타입으로 잡으면 trace-flow의 구현체 조회가 통째로 오염된다(도그푸딩에서 발견).
 */
function parseSupertypes(head: string): string[] {
  const clean = head.replace(/<[^<>]*>/g, ''); // 제네릭 파라미터의 extends 제외

  const java = clean.match(/\b(?:extends|implements)\s+([^{]+)$/);
  if (java) return names(java[1]);

  const firstParen = clean.indexOf('(');
  const firstColon = clean.indexOf(':');

  // 콜론보다 여는 괄호가 먼저면 주 생성자다 → 닫는 괄호 뒤부터가 상위타입 구간
  if (firstParen !== -1 && (firstColon === -1 || firstParen < firstColon)) {
    let depth = 0;
    for (let j = firstParen; j < clean.length; j++) {
      if (clean[j] === '(') depth++;
      else if (clean[j] === ')' && --depth === 0) {
        const after = clean.slice(j + 1);
        const c = after.indexOf(':');
        return c === -1 ? [] : names(after.slice(c + 1));
      }
    }
    return [];
  }
  return firstColon === -1 ? [] : names(clean.slice(firstColon + 1));
}

/** 상위타입 이름만. `Bar(arg), Baz` 의 생성자 인자는 제외한다. */
function names(region: string): string[] {
  return [...region.replace(/\([^()]*\)/g, '').matchAll(/\b([A-Z]\w*)/g)].map((m) => m[1]);
}

/**
 * DI 필드 — 호출 수신자 타입 해석의 유일한 근거.
 * Kotlin 주 생성자 `class A(private val b: B)` 와 본문 필드 `val b: B` 를 모두 본다.
 */
function parseDiFields(t: string, declStart: number, body: { start: number; end: number }): DiField[] {
  const fields: DiField[] = [];
  const seen = new Set<string>();

  const add = (name: string, type: string, at: number) => {
    if (seen.has(name)) return;
    seen.add(name);
    fields.push({ name, type, line: lineAt(t, at) });
  };

  // 주 생성자 (선언부 ~ 본문 시작)
  const ctor = t.slice(declStart, body.start);
  for (const m of ctor.matchAll(/\b(?:val|var)\s+(\w+)\s*:\s*([A-Z][\w.]*)/g)) add(m[1], last(m[2]), declStart + m.index!);
  // Java 생성자/필드 `private final Foo foo;`
  for (const m of t.slice(body.start, body.end).matchAll(/\b(?:private|protected|public)\s+final\s+([A-Z][\w.<>]*)\s+(\w+)\s*[;=]/g))
    add(m[2], last(stripGenerics(m[1])), body.start + m.index!);
  // Kotlin 본문 필드
  for (const m of t.slice(body.start, body.end).matchAll(/\b(?:private|protected|internal)?\s*(?:val|var)\s+(\w+)\s*:\s*([A-Z][\w.]*)/g))
    add(m[1], last(m[2]), body.start + m.index!);

  return fields;
}

function parseMethods(path: string, c: Cleaned, body: { start: number; end: number }, lang: Lang, gaps: ScanGap[]): MethodSymbol[] {
  const t = c.text;
  const region = t.slice(body.start, body.end);
  const re = lang === 'kotlin' ? KT_FUN_RE : JAVA_METHOD_RE;
  re.lastIndex = 0;

  const methods: MethodSymbol[] = [];
  for (const m of region.matchAll(re)) {
    const declStart = body.start + m.index!;
    const name = m[1];
    const parenEnd = findParenEnd(t, declStart + m[0].length - 1);

    // 표현식 본문(`fun f() = a.b()`)을 먼저 가른다.
    // 먼저 blockRange를 부르면 `= repo.findAll().map { ... }` 의 **람다 `{`를 본문으로 오인**한다.
    const expr = parenEnd === -1 ? null : expressionBody(t, parenEnd);
    const range = expr ?? (parenEnd === -1 ? null : blockRange(t, parenEnd));

    const method: MethodSymbol = {
      name,
      line: lineAt(t, declStart),
      bodyStart: range?.start ?? declStart,
      bodyEnd: range?.end ?? declStart,
      annotations: annotationsBefore(c, declStart),
      calls: range ? parseCalls(t, range.start, range.end) : [],
    };
    methods.push(method);
  }
  return methods;
}

/**
 * Kotlin 표현식 본문 `fun f(): T = expr` 의 범위.
 * 반환 타입 뒤 `=` 가 `{` 보다 먼저 나오면 표현식 본문이다.
 * 범위는 괄호·중괄호 깊이가 0인 상태에서 줄이 끝나는 곳까지 (체이닝·람다 포함).
 */
function expressionBody(t: string, from: number): { start: number; end: number } | null {
  let i = from;
  while (i < t.length && i < from + 400) {
    const ch = t[i];
    if (ch === '{' || ch === ';' || ch === '}') return null;
    if (ch === '=' && t[i + 1] !== '=' && !'=!<>'.includes(t[i - 1])) break;
    i++;
  }
  if (i >= t.length || t[i] !== '=') return null;

  const start = i + 1;
  let depth = 0;
  for (let j = start; j < t.length; j++) {
    const ch = t[j];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') {
      if (depth === 0) return { start, end: j }; // 클래스 본문 끝에 닿음
      depth--;
    } else if (ch === '\n' && depth === 0) {
      // 다음 줄이 체이닝(`.foo()`)이면 계속 이어붙인다
      const nextLine = t.slice(j + 1, t.indexOf('\n', j + 1) === -1 ? t.length : t.indexOf('\n', j + 1)).trim();
      if (!nextLine.startsWith('.') && !nextLine.startsWith('?.')) return { start, end: j };
    }
  }
  return { start, end: t.length };
}

function findParenEnd(t: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < t.length && i < openIdx + 4000; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function parseCalls(t: string, from: number, to: number): CallSite[] {
  const region = t.slice(from, to);
  const calls: CallSite[] = [];
  for (const m of region.matchAll(CALL_RE)) {
    const method = m[2];
    if (KEYWORDS.has(method)) continue;
    const receiver = m[1] && !KEYWORDS.has(m[1]) ? m[1] : null;
    calls.push({ receiver, method, line: lineAt(t, from + m.index!) });
  }
  return calls;
}

// ── 엔드포인트 ──────────────────────────────────────────────────

const HTTP_ANN: Record<string, string> = {
  GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT',
  DeleteMapping: 'DELETE', PatchMapping: 'PATCH',
};

function detectEndpoints(type: TypeSymbol, c: Cleaned): Endpoint[] {
  const out: Endpoint[] = [];
  const isController = type.annotations.some((a) => a.name === 'RestController' || a.name === 'Controller');
  const base = annotationArg(type.annotations.find((a) => a.name === 'RequestMapping')) ?? '';

  for (const method of type.methods) {
    for (const ann of method.annotations) {
      const verb = HTTP_ANN[ann.name];
      if (isController && verb) {
        out.push(mk(`${verb} ${joinPath(base, annotationArg(ann) ?? '')}`, 'http', type, method));
      } else if (isController && ann.name === 'RequestMapping') {
        const m = ann.args?.match(/RequestMethod\.(\w+)/)?.[1] ?? 'ANY';
        out.push(mk(`${m} ${joinPath(base, annotationArg(ann) ?? '')}`, 'http', type, method));
      } else if (ann.name === 'KafkaListener' || ann.name === 'RabbitListener' || ann.name === 'SqsListener') {
        out.push(mk(`${ann.name} ${annotationArg(ann) ?? '(topic 미상)'}`, 'message', type, method));
      } else if (ann.name === 'Scheduled') {
        out.push(mk(`Scheduled ${type.name}.${method.name}`, 'schedule', type, method));
      } else if (ann.name === 'EventListener' || ann.name === 'TransactionalEventListener') {
        out.push(mk(`Event ${type.name}.${method.name}`, 'event', type, method));
      }
    }
  }
  return out;
}

function mk(key: string, kind: Endpoint['kind'], type: TypeSymbol, method: MethodSymbol): Endpoint {
  return { key, kind, typeName: type.name, methodName: method.name, line: method.line };
}

function joinPath(base: string, sub: string): string {
  const b = base.replace(/\/$/, '');
  const s = sub.startsWith('/') || sub === '' ? sub : `/${sub}`;
  return `${b}${s}` || '/';
}

const last = (fqn: string) => fqn.split('.').pop()!;
const stripGenerics = (s: string) => s.replace(/<.*>/, '');

export type { Annotation };
