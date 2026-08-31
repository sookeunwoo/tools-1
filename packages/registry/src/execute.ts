/**
 * 툴 실행 파이프라인 — 모든 surface(CLI/MCP)가 공유하는 단일 경로.
 *
 * 순서: 계약검증 → 정책 → 멱등성 → 캐시 → ledger.start → 임대 → 실행(타임아웃)
 *       → 출력검증 → evidence 강제 → 마스킹 → 캐시저장 → ledger.end
 *
 * surface에는 로직을 두지 않는다 (설계원칙 P1). 여기가 유일한 진실이다.
 */

import { loadConfig, resolveRepo } from '#core/config.ts';
import { DevkitError, toDevkitError } from '#core/errors.ts';
import { validate, formatIssues } from '#core/schema.ts';
import * as policy from '#core/policy.ts';
import * as lease from '#core/lease.ts';
import * as cache from '#core/cache.ts';
import {
  startRun,
  endRun,
  newRunId,
  findIdempotent,
  type RunStatus,
} from '#core/ledger.ts';
import type { Envelope, Evidence, ToolContext, ToolResult } from '#core/contract.ts';
import { getTool, loadModule, type ToolEntry } from './registry.ts';

export type ExecuteOptions = {
  agentId?: string;
  traceId?: string;
  parentSpanId?: string;
  idempotencyKey?: string;
  approvalToken?: string;
  /** 캐시를 무시하고 새로 실행한다. */
  refresh?: boolean;
  /** ledger에 입력 원문을 남긴다(기본 false — 시크릿/PII 보호). */
  recordInput?: boolean;
  /** 배타 자원 대기 시간. */
  leaseWaitMs?: number;
  /** 실행하지 않고 해석된 계획만 돌려준다. */
  explain?: boolean;
  profile?: string;
};

export type ExplainReport = {
  tool: string;
  version: string;
  resolvedInput: unknown;
  policy: policy.PolicyDecision;
  leasePlan: string[];
  cache: { eligible: boolean; key: string | null; hit: boolean; reason: string };
  repoPath?: string;
  commitSha?: string;
  timeoutSec: number;
};

export async function execute(
  toolName: string,
  rawInput: unknown,
  opts: ExecuteOptions = {},
): Promise<Envelope | ExplainReport> {
  const runId = newRunId();
  const agentId = opts.agentId ?? process.env.DEVKIT_AGENT_ID ?? 'local';
  const traceId = opts.traceId ?? runId;
  const held: lease.Lease[] = [];
  let heartbeatTimer: NodeJS.Timeout | undefined;
  let recorded = false; // ledger에 startRun이 기록되었는가

  try {
    return await run();
  } catch (err) {
    const e = toDevkitError(err);
    const status: RunStatus =
      e.code === 'TOOL_TIMEOUT' ? 'timeout' : e.code.startsWith('POLICY_') ? 'denied' : 'error';

    // 계약 위반·정책 거부는 실행 전에 걸러지지만 ledger에는 남겨야 한다.
    // 에이전트가 가장 자주 겪는 실패가 INPUT_INVALID인데 이게 기록되지 않으면
    // dk stats의 성공률이 실제보다 좋아 보이고, 개선할 지점을 못 찾는다.
    if (!recorded) {
      startRun({
        runId, traceId, parentSpanId: opts.parentSpanId, agentId,
        tool: toolName, toolVersion: '-',
        input: rawInput, idempotencyKey: opts.idempotencyKey, recordInput: opts.recordInput,
      });
    }
    endRun({ runId, status, errorCode: e.code, leases: held.map((l) => l.resourceKey) });
    throw e;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    lease.releaseAll(held);
  }

  async function run(): Promise<Envelope | ExplainReport> {
  const startedAt = Date.now();
  const entry = getTool(toolName);
  const manifest = entry.manifest;

  // 1. 입력 계약 검증 (default 채워짐)
  const inputResult = validate(manifest.inputSchema, rawInput ?? {});
  if (!inputResult.valid) {
    throw new DevkitError({
      code: 'INPUT_INVALID',
      message: `입력이 '${toolName}' 계약과 맞지 않습니다 — ${formatIssues(inputResult.issues)}`,
      hint: `dk describe ${toolName} 로 입력 스키마를 확인하세요.`,
      retryable: false,
    });
  }
  const input = (inputResult.value ?? {}) as Record<string, unknown>;

  // 2. 설정 + 저장소 해석
  const repoName = typeof input.repo === 'string' ? input.repo : undefined;
  let config = loadConfig({ profile: opts.profile });
  let repoPath: string | undefined;
  if (repoName) {
    repoPath = resolveRepo(config, repoName).path;
    config = loadConfig({ profile: opts.profile, repoPath });
  }

  // 3. 정책 게이트
  const decision = policy.check({ manifest, input, config, approvalToken: opts.approvalToken });

  // 4. 캐시 적격성 — dirty 워킹트리면 캐시하지 않는다 (낡은 분석 > 캐시 미스)
  const state = repoPath ? cache.repoState(repoPath) : { commitSha: null, dirty: false };
  const cacheEligible = manifest.determinism !== 'nondeterministic' && (manifest.determinism === 'pure' || !!state.commitSha);
  const key = cacheEligible
    ? cache.cacheKey({ tool: manifest.name, toolVersion: manifest.version, input, commitSha: state.commitSha ?? undefined })
    : null;

  const leasePlan = manifest.concurrency.mode === 'exclusive' ? [resolveResourceKey(entry, input)] : [];

  if (opts.explain) {
    return {
      tool: manifest.name,
      version: manifest.version,
      resolvedInput: input,
      policy: decision,
      leasePlan,
      cache: {
        eligible: cacheEligible,
        key,
        hit: key ? cache.get(key) !== null : false,
        reason: cacheEligible
          ? '캐시 사용 가능'
          : state.dirty
            ? '워킹트리에 커밋되지 않은 변경이 있어 캐시를 쓰지 않습니다'
            : `determinism=${manifest.determinism} 이라 캐시 대상이 아닙니다`,
      },
      repoPath,
      commitSha: state.commitSha ?? undefined,
      timeoutSec: manifest.timeoutSec,
    };
  }

  if (decision.effect !== 'allow') throw policy.toDenyError(decision);

  // 5. 멱등성 — 같은 키로 이미 성공했으면 재실행하지 않는다
  if (opts.idempotencyKey) {
    const prior = findIdempotent(manifest.name, opts.idempotencyKey);
    if (prior && key) {
      const cached = cache.get<Envelope>(key);
      if (cached) return { ...cached, runId: prior, timings: { totalMs: Date.now() - startedAt, cacheHit: true } };
    }
  }

  // 6. 캐시 조회
  if (key && !opts.refresh) {
    const cached = cache.get<Envelope>(key);
    if (cached) {
      startRun({ runId, traceId, parentSpanId: opts.parentSpanId, agentId, tool: manifest.name, toolVersion: manifest.version, repo: repoName, input, idempotencyKey: opts.idempotencyKey, recordInput: opts.recordInput });
      endRun({ runId, status: 'ok', cacheHit: true, evidenceCount: cached.evidence?.length ?? 0, confidence: cached.confidence });
      return { ...cached, runId, timings: { totalMs: Date.now() - startedAt, cacheHit: true } };
    }
  }

  startRun({
    runId, traceId, parentSpanId: opts.parentSpanId, agentId,
    tool: manifest.name, toolVersion: manifest.version, repo: repoName,
    input, idempotencyKey: opts.idempotencyKey, recordInput: opts.recordInput,
  });
  recorded = true;

  const controller = new AbortController();

  {
    // 7. 임대 — 키 사전순 정렬로 데드락 차단 (lease.acquireAll)
    if (leasePlan.length > 0) {
      held.push(...(await lease.acquireAll(leasePlan, agentId, runId, { waitMs: opts.leaseWaitMs ?? 0 })));
      heartbeatTimer = setInterval(() => {
        for (const l of held) lease.heartbeat(l.resourceKey, runId);
      }, lease.HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
    }

    // 8. 실행 (타임아웃)
    const ctx: ToolContext = {
      runId, traceId, agentId, config, repoPath,
      commitSha: state.commitSha ?? undefined,
      lease: async (resourceKey, o) => {
        held.push(await lease.acquire(resourceKey, agentId, runId, { waitMs: o?.waitMs ?? 0, ttlMs: o?.ttlMs }));
      },
      log: (message, fields) => {
        if (process.env.DEVKIT_TRACE) console.error(`[${manifest.name}] ${message}`, fields ?? '');
      },
      signal: controller.signal,
    };

    const mod = await loadModule(entry);
    const result = await withTimeout(
      Promise.resolve(mod.run(input, ctx)),
      manifest.timeoutSec * 1000,
      controller,
      manifest.name,
    );

    // 9. 출력 계약 검증
    const outputResult = validate(manifest.outputSchema, result.data);
    if (!outputResult.valid) {
      throw new DevkitError({
        code: 'OUTPUT_CONTRACT_VIOLATION',
        message: `'${manifest.name}'의 출력이 outputSchema와 맞지 않습니다 — ${formatIssues(outputResult.issues)}`,
        hint: 'index.ts의 반환값 또는 manifest.json의 outputSchema 중 하나가 틀렸습니다.',
        retryable: false,
        source: { file: `plugins/${manifest.name}/index.ts`, line: 1 },
      });
    }

    // 10. evidence 강제 (설계원칙 P3) — 근거 없는 결과는 반환되지 않는다
    const evidence: Evidence[] = result.evidence ?? [];
    if (evidence.length === 0 && !manifest.evidenceOptional) {
      throw new DevkitError({
        code: 'EVIDENCE_REQUIRED',
        message: `'${manifest.name}'이 evidence 없이 결과를 반환했습니다`,
        hint: '모든 툴은 근거(파일:라인, 쿼리, 명령)를 반환해야 합니다. 메타 툴이면 manifest에 evidenceOptional: true 를 넣으세요.',
        retryable: false,
        source: { file: `plugins/${manifest.name}/index.ts`, line: 1 },
      });
    }

    const envelope: Envelope = policy.sanitizeOutput({
      ok: true,
      toolVersion: manifest.version,
      runId,
      confidence: result.confidence,
      data: outputResult.value,
      evidence,
      unresolved: result.unresolved,
      nextActions: result.nextActions,
      truncated: result.truncated,
      timings: { totalMs: Date.now() - startedAt, cacheHit: false },
    });

    if (key) cache.set(key, manifest.name, envelope);
    endRun({
      runId, status: 'ok', cacheHit: false,
      evidenceCount: evidence.length,
      confidence: result.confidence,
      leases: held.map((l) => l.resourceKey),
    });
    return envelope;
  }
  }
}

/** manifest의 resourceKey에 입력값을 치환한다. 예: "gradle:{repo}" → "gradle:my-service" */
function resolveResourceKey(entry: ToolEntry, input: Record<string, unknown>): string {
  const template = entry.manifest.concurrency.resourceKey ?? entry.manifest.name;
  return template.replace(/\{(\w+)\}/g, (_m, field) => String(input[field] ?? 'default'));
}

async function withTimeout(
  promise: Promise<ToolResult>,
  ms: number,
  controller: AbortController,
  toolName: string,
): Promise<ToolResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(
            new DevkitError({
              code: 'TOOL_TIMEOUT',
              message: `'${toolName}'이 ${ms / 1000}초 안에 끝나지 않았습니다`,
              hint: 'manifest.json의 timeoutSec을 늘리거나 입력 범위를 좁히세요.',
              retryable: true,
            }),
          );
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
