/**
 * JSON Schema 서브셋 검증기 (의존성 0).
 *
 * 툴 계약(manifest)의 inputSchema/outputSchema를 검증한다.
 * 목적은 "완전한 JSON Schema 구현"이 아니라 "에이전트가 잘못 만든 입력을
 * 실행 전에 명확한 메시지로 되돌려 주는 것"이다.
 *
 * 지원: type, required, properties, additionalProperties(false), enum,
 *       items, minimum/maximum, minLength/maxLength, minItems, pattern,
 *       default(채워 넣기), const, oneOf/anyOf(단순 분기)
 */

export type Schema = Record<string, any>;
export type ValidationIssue = { path: string; message: string };

export type ValidationResult = {
  valid: boolean;
  issues: ValidationIssue[];
  /** default가 채워진 값. valid일 때만 의미가 있다. */
  value: unknown;
};

export function validate(schema: Schema, input: unknown): ValidationResult {
  const issues: ValidationIssue[] = [];
  const value = walk(schema, input, '$', issues);
  return { valid: issues.length === 0, issues, value };
}

function walk(schema: Schema, input: unknown, path: string, issues: ValidationIssue[]): unknown {
  if (!schema || typeof schema !== 'object') return input;

  let value = input;
  if (value === undefined && 'default' in schema) value = structuredClone(schema.default);
  if (value === undefined) return value;

  if ('const' in schema && !deepEqual(value, schema.const)) {
    issues.push({ path, message: `${JSON.stringify(schema.const)} 이어야 합니다` });
    return value;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((c: unknown) => deepEqual(c, value))) {
    issues.push({ path, message: `허용된 값이 아닙니다. 가능: ${schema.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}` });
    return value;
  }

  const branches = schema.oneOf ?? schema.anyOf;
  if (Array.isArray(branches)) {
    const matched = branches.some((b: Schema) => validate(b, value).valid);
    if (!matched) issues.push({ path, message: 'oneOf/anyOf 분기 중 어느 것과도 맞지 않습니다' });
    return value;
  }

  const types: string[] = schema.type === undefined ? [] : ([] as string[]).concat(schema.type);
  if (types.length > 0 && !types.some((t) => matchesType(t, value))) {
    issues.push({ path, message: `타입이 ${types.join('|')} 이어야 합니다 (받은 값: ${typeName(value)})` });
    return value;
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum)
      issues.push({ path, message: `${schema.minimum} 이상이어야 합니다` });
    if (typeof schema.maximum === 'number' && value > schema.maximum)
      issues.push({ path, message: `${schema.maximum} 이하여야 합니다` });
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      issues.push({ path, message: `길이가 ${schema.minLength} 이상이어야 합니다` });
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      issues.push({ path, message: `길이가 ${schema.maxLength} 이하여야 합니다` });
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value))
      issues.push({ path, message: `패턴 ${schema.pattern} 에 맞지 않습니다` });
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      issues.push({ path, message: `항목이 ${schema.minItems}개 이상이어야 합니다` });
    if (schema.items) {
      value = value.map((item, i) => walk(schema.items, item, `${path}[${i}]`, issues));
    }
  }

  if (isPlainObject(value)) {
    const obj = { ...(value as Record<string, unknown>) };
    const props: Record<string, Schema> = schema.properties ?? {};

    for (const key of schema.required ?? []) {
      const hasDefault = props[key] && 'default' in props[key];
      if (obj[key] === undefined && !hasDefault) {
        issues.push({ path: `${path}.${key}`, message: '필수 항목이 누락되었습니다' });
      }
    }

    for (const [key, sub] of Object.entries(props)) {
      const next = walk(sub, obj[key], `${path}.${key}`, issues);
      if (next !== undefined) obj[key] = next;
    }

    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) {
          issues.push({
            path: `${path}.${key}`,
            message: `알 수 없는 항목입니다. 허용: ${Object.keys(props).join(', ') || '(없음)'}`,
          });
        }
      }
    }
    value = obj;
  }

  return value;
}

function matchesType(type: string, value: unknown): boolean {
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return typeof value === type;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** 사람과 에이전트 모두 읽을 수 있는 한 줄 요약. */
export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join('; ');
}
