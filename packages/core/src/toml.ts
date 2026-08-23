/**
 * TOML 서브셋 파서.
 *
 * 왜 직접 쓰는가: 설계원칙 P7(네이티브 의존성 0)을 위해 의존성을 안 쓰는데
 * Node에는 TOML 파서가 없다. 지원 범위를 좁게 유지하고, 지원하지 않는 문법은
 * 조용히 무시하지 않고 명확한 에러를 낸다.
 *
 * 지원: 주석(#), [table], [nested.table], key = value,
 *       문자열/정수/실수/불리언/단일행 배열
 * 미지원: [[array of tables]], 인라인 테이블, 멀티라인 문자열, 날짜
 */

import { DevkitError } from './errors.ts';

export type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };

export function parseToml(text: string, file = '<inline>'): Record<string, TomlValue> {
  const root: Record<string, TomlValue> = {};
  let table = root;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (line === '') continue;

    if (line.startsWith('[[')) {
      throw unsupported('배열 테이블([[...]])', file, i + 1);
    }

    if (line.startsWith('[')) {
      if (!line.endsWith(']')) throw syntax('테이블 헤더가 닫히지 않았습니다', file, i + 1);
      table = descend(root, line.slice(1, -1).trim().split('.'), file, i + 1);
      continue;
    }

    const eq = indexOfTopLevelEquals(line);
    if (eq === -1) throw syntax(`'key = value' 형식이 아닙니다: ${line}`, file, i + 1);

    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '');
    const value = parseValue(line.slice(eq + 1).trim(), file, i + 1);
    if (key === '') throw syntax('키가 비어 있습니다', file, i + 1);
    table[key] = value;
  }
  return root;
}

function descend(
  root: Record<string, TomlValue>,
  parts: string[],
  file: string,
  line: number,
): Record<string, TomlValue> {
  let cur = root;
  for (const part of parts) {
    const key = part.trim().replace(/^["']|["']$/g, '');
    if (key === '') throw syntax('테이블 이름이 비어 있습니다', file, line);
    const next = cur[key];
    if (next === undefined) {
      const created: Record<string, TomlValue> = {};
      cur[key] = created;
      cur = created;
    } else if (typeof next === 'object' && !Array.isArray(next)) {
      cur = next as Record<string, TomlValue>;
    } else {
      throw syntax(`'${key}'가 이미 값으로 정의되어 테이블이 될 수 없습니다`, file, line);
    }
  }
  return cur;
}

function parseValue(text: string, file: string, line: number): TomlValue {
  if (text === '') throw syntax('값이 비어 있습니다', file, line);

  if (text.startsWith('[')) {
    if (!text.endsWith(']')) throw unsupported('여러 줄에 걸친 배열', file, line);
    const inner = text.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevel(inner).map((part) => parseValue(part.trim(), file, line));
  }

  if (text.startsWith('{')) throw unsupported('인라인 테이블({...})', file, line);

  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    if (text.length < 2) throw syntax('문자열이 닫히지 않았습니다', file, line);
    const body = text.slice(1, -1);
    return text[0] === '"' ? unescape(body) : body;
  }

  if (text === 'true') return true;
  if (text === 'false') return false;

  const num = Number(text.replace(/_/g, ''));
  if (text !== '' && Number.isFinite(num)) return num;

  throw syntax(`값을 해석할 수 없습니다: ${text} (문자열이면 따옴표로 감싸세요)`, file, line);
}

function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, c) => {
    if (c === 'n') return '\n';
    if (c === 't') return '\t';
    if (c === 'r') return '\r';
    return c;
  });
}

function stripComment(line: string): string {
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
    } else if (c === '"' || c === "'") {
      inString = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function indexOfTopLevelEquals(line: string): number {
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
    } else if (c === '"' || c === "'") inString = c;
    else if (c === '=') return i;
  }
  return -1;
}

function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'") inString = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail !== '') out.push(tail);
  return out;
}

function syntax(message: string, file: string, line: number): DevkitError {
  return new DevkitError({
    code: 'CONFIG_PARSE_ERROR',
    message: `${file}:${line} — ${message}`,
    hint: '설정 파일 문법을 확인하세요.',
    retryable: false,
    fixCommand: `dk doctor`,
  });
}

function unsupported(what: string, file: string, line: number): DevkitError {
  return new DevkitError({
    code: 'CONFIG_UNSUPPORTED_SYNTAX',
    message: `${file}:${line} — ${what}은(는) devkit의 TOML 서브셋에서 지원하지 않습니다`,
    hint: '지원 범위: [table], key = value, 문자열/숫자/불리언/단일행 배열. packages/core/src/toml.ts 참고.',
    retryable: false,
  });
}
