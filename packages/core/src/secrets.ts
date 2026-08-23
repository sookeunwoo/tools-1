/**
 * 시크릿 해석 + 마스킹 (plan.md §6.2).
 *
 * 규칙 세 가지:
 *   1. 설정 파일에는 `keychain://service/account` 참조만 저장한다. 평문 금지.
 *   2. 해석된 값은 자식 프로세스 env로만 전달한다.
 *   3. ledger/로그/에러에 기록되기 직전 redact()로 한 번 더 거른다 (이중 방어).
 */

import { execFileSync } from 'node:child_process';
import { DevkitError } from './errors.ts';

const KEYCHAIN_PREFIX = 'keychain://';
const ENV_PREFIX = 'env://';

/** 이 프로세스가 해석한 모든 시크릿 값. redact()가 참조한다. */
const seen = new Set<string>();

export function isSecretRef(value: unknown): value is string {
  return typeof value === 'string' && (value.startsWith(KEYCHAIN_PREFIX) || value.startsWith(ENV_PREFIX));
}

export function resolveSecret(ref: string): string {
  if (ref.startsWith(ENV_PREFIX)) {
    const name = ref.slice(ENV_PREFIX.length);
    const value = process.env[name];
    if (value === undefined) {
      throw new DevkitError({
        code: 'SECRET_NOT_FOUND',
        message: `환경변수 ${name} 가 설정되지 않았습니다`,
        hint: `export ${name}=... 로 설정하거나 keychain:// 참조를 쓰세요.`,
        retryable: false,
      });
    }
    return remember(value);
  }

  if (!ref.startsWith(KEYCHAIN_PREFIX)) {
    throw new DevkitError({
      code: 'SECRET_BAD_REF',
      message: `시크릿 참조 형식이 아닙니다: ${ref}`,
      hint: 'keychain://<service>/<account> 또는 env://<NAME> 형식을 쓰세요.',
      retryable: false,
    });
  }

  const [service, account] = ref.slice(KEYCHAIN_PREFIX.length).split('/');
  if (!service || !account) {
    throw new DevkitError({
      code: 'SECRET_BAD_REF',
      message: `keychain 참조에 service 또는 account가 없습니다: ${ref}`,
      hint: 'keychain://<service>/<account> 형식이어야 합니다.',
      retryable: false,
    });
  }

  try {
    const out = execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return remember(out.replace(/\n$/, ''));
  } catch {
    throw new DevkitError({
      code: 'SECRET_NOT_FOUND',
      message: `Keychain에서 시크릿을 찾을 수 없습니다: ${ref}`,
      hint: 'Keychain 항목을 먼저 등록하세요.',
      retryable: false,
      fixCommand: `security add-generic-password -s ${service} -a ${account} -w '<값>'`,
    });
  }
}

/** 설정 트리를 훑어 시크릿 참조를 전부 해석한다. */
export function resolveTree<T>(value: T): T {
  if (isSecretRef(value)) return resolveSecret(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => resolveTree(v)) as unknown as T;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTree(v);
    return out as T;
  }
  return value;
}

/**
 * 기록 직전 마스킹. 해석된 시크릿 값과 흔한 토큰 패턴을 모두 지운다.
 * 길이 6 미만 값은 오탐이 심해 건너뛴다.
 */
export function redact(input: string): string {
  let out = input;
  for (const secret of seen) {
    if (secret.length < 6) continue;
    out = out.split(secret).join('***');
  }
  return out
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, '***')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '***')
    .replace(/\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g, '***')
    .replace(/(password|passwd|secret|token|api[_-]?key)(["']?\s*[:=]\s*["']?)([^\s"',}]{4,})/gi, '$1$2***');
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

function remember(value: string): string {
  if (value.length >= 6) seen.add(value);
  return value;
}

/** 테스트 전용. */
export function _resetSeen(): void {
  seen.clear();
}
