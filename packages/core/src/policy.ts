/**
 * 정책 게이트 (plan.md §6.3).
 *
 * 실행 전 5단계: allow/deny → prod 가드 → 승인 게이트 → 사내 보안 훅 → 출력 마스킹
 *
 * 사내 보안 훅(4단계)은 구체 도구가 확정되기 전까지 인터페이스만 두고 noop이다.
 * 사내 시스템 접근 툴 자체가 M5 이후이므로 지금 이 자리는 비워둬도 위험하지 않다.
 */

import type { Config } from './config.ts';
import type { Manifest } from './contract.ts';
import { DevkitError } from './errors.ts';
import { redactDeep } from './secrets.ts';

export type PolicyDecision =
  | { effect: 'allow'; reasons: string[] }
  | { effect: 'deny'; code: string; reason: string; hint?: string }
  | { effect: 'needs-approval'; reason: string; approvalKey: string };

export type PolicyInput = {
  manifest: Manifest;
  input: Record<string, unknown>;
  config: Config;
  /** 호출자가 명시적으로 넘긴 승인 토큰. */
  approvalToken?: string;
};

export function check(p: PolicyInput): PolicyDecision {
  const reasons: string[] = [];
  const policy = (p.config.policy ?? {}) as Record<string, unknown>;

  // 1. deny 우선, 그다음 allow 목록
  const deny = toList(policy.deny_tools);
  if (deny.includes(p.manifest.name)) {
    return {
      effect: 'deny',
      code: 'POLICY_TOOL_DENIED',
      reason: `툴 '${p.manifest.name}'가 정책에서 차단되었습니다`,
      hint: '~/.devkit/config.toml 의 [policy] deny_tools 를 확인하세요.',
    };
  }
  const allow = toList(policy.allow_tools);
  if (allow.length > 0 && !allow.includes(p.manifest.name)) {
    return {
      effect: 'deny',
      code: 'POLICY_TOOL_NOT_ALLOWED',
      reason: `툴 '${p.manifest.name}'가 허용 목록에 없습니다`,
      hint: `허용된 툴: ${allow.join(', ')}`,
    };
  }
  reasons.push('allow/deny 통과');

  // 2. prod 가드 — 읽기가 아닌 작업은 prod에서 기본 차단
  const env = String(p.input.env ?? p.input.environment ?? '').toLowerCase();
  const isProd = env === 'prod' || env === 'production';
  if (isProd && p.manifest.sideEffects !== 'read') {
    const allowProdWrites = policy.allow_prod_writes === true;
    if (!allowProdWrites) {
      return {
        effect: 'deny',
        code: 'POLICY_PROD_WRITE_BLOCKED',
        reason: `prod 환경에 대한 ${p.manifest.sideEffects} 작업은 기본 차단입니다`,
        hint: '정말 필요하면 [policy] allow_prod_writes = true 를 설정하고 승인 토큰과 함께 호출하세요.',
      };
    }
    reasons.push('prod 쓰기가 설정으로 허용됨');
  }
  if (isProd) reasons.push('prod 대상 — 감사 로그 기록됨');

  // 3. 승인 게이트 — 블로킹하지 않고 PENDING을 반환해 에이전트가 판단하게 한다
  if (p.manifest.requiresApproval || (isProd && p.manifest.sideEffects !== 'read')) {
    const approvalKey = `${p.manifest.name}:${env || 'default'}`;
    const granted = toList(policy.approvals).includes(approvalKey) || p.approvalToken === approvalKey;
    if (!granted) {
      return { effect: 'needs-approval', reason: `'${approvalKey}' 승인이 필요합니다`, approvalKey };
    }
    reasons.push(`승인 확인됨 (${approvalKey})`);
  }

  // 4. 사내 보안 훅 (M5에서 실구현)
  const decision = securityHook(p);
  if (decision) return decision;
  reasons.push('사내 보안 훅: noop (M5 예정)');

  return { effect: 'allow', reasons };
}

/**
 * 사내 감사/DLP 도구 연동 지점.
 * 지금은 noop. 사내 정책 확인(plan.md §15-1) 후 실구현한다.
 */
function securityHook(_p: PolicyInput): PolicyDecision | null {
  return null;
}

/** 5. 출력 마스킹 — 에이전트 컨텍스트에 닿기 전 시크릿/PII 제거. */
export function sanitizeOutput<T>(value: T): T {
  return redactDeep(value);
}

export function toDenyError(decision: PolicyDecision): DevkitError {
  if (decision.effect === 'deny') {
    return new DevkitError({
      code: decision.code,
      message: decision.reason,
      hint: decision.hint,
      retryable: false,
    });
  }
  if (decision.effect === 'needs-approval') {
    return new DevkitError({
      code: 'POLICY_APPROVAL_REQUIRED',
      message: decision.reason,
      hint: '승인 후 재시도하세요. 승인은 사람이 명시적으로 부여해야 합니다.',
      retryable: true,
      fixCommand: `dk approve ${decision.approvalKey}`,
    });
  }
  throw new Error('allow 결정으로 에러를 만들 수 없습니다');
}

function toList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}
