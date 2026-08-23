/**
 * devkit-observe — 관측성의 에이전트 쪽 절반 (plan.md §7.2).
 *
 * 사람은 `dk ps`/`dk stats`로 보고, 에이전트는 이 툴로 본다.
 * 이게 있으면 에이전트가 "지금 A2가 gradle 락을 잡고 있으니 나는 정적 분석 먼저"
 * 같은 판단을 스스로 한다.
 */

import { listRuns, toolStats } from '#core/ledger.ts';
import { activeLeases } from '#core/lease.ts';
import { listTools } from '#registry/registry.ts';
import type { Evidence, NextAction, ToolContext, ToolResult, Unresolved } from '#core/contract.ts';

type Input = {
  view: 'summary' | 'runs' | 'stats' | 'leases' | 'tools' | 'failures';
  sinceHours: number;
  limit: number;
  tool?: string;
};

export async function run(input: Input, ctx: ToolContext): Promise<ToolResult> {
  const sinceMs = input.sinceHours * 3600 * 1000;
  const data: Record<string, unknown> = { view: input.view, generatedAt: new Date().toISOString() };
  const evidence: Evidence[] = [];
  const notes: string[] = [];
  const nextActions: NextAction[] = [];
  const unresolved: Unresolved[] = [];

  const wantsRuns = input.view === 'runs' || input.view === 'summary';
  const wantsStats = input.view === 'stats' || input.view === 'summary';
  const wantsLeases = input.view === 'leases' || input.view === 'summary';
  const wantsTools = input.view === 'tools' || input.view === 'summary';
  const wantsFailures = input.view === 'failures' || input.view === 'summary';

  if (wantsRuns) {
    // 자기 자신은 제외한다 — 조회 시점에 아직 'running'이라 결과를 오염시킨다
    const runs = listRuns({ limit: input.limit + 1, tool: input.tool, sinceMs })
      .filter((r) => r.run_id !== ctx.runId)
      .slice(0, input.limit);
    data.runs = runs.map(shapeRun);
    evidence.push({ kind: 'query', source: 'sqlite:runs', text: `최근 ${input.sinceHours}시간 실행 조회`, rows: runs.length });
  }

  if (wantsStats) {
    const stats = toolStats(sinceMs).filter((s) => !input.tool || s.tool === input.tool);
    data.stats = stats.map((s) => ({
      ...s,
      successRate: round(s.successRate),
      cacheHitRate: round(s.cacheHitRate),
      avgConfidence: s.avgConfidence === null ? null : round(s.avgConfidence),
    }));
    evidence.push({ kind: 'query', source: 'sqlite:runs', text: '툴별 집계(p50/p95/성공률/캐시적중)', rows: stats.length });

    // 설계원칙 P10 집행: 안 쓰이는 툴을 눈에 보이게 한다
    const used = new Set(stats.map((s) => s.tool));
    const unused = listTools().map((t) => t.manifest.name).filter((n) => !used.has(n));
    if (unused.length > 0) notes.push(`최근 ${input.sinceHours}시간 미사용 툴: ${unused.join(', ')} (P10: 30일 미사용이면 삭제 대상)`);

    for (const s of stats) {
      if (s.calls >= 5 && s.successRate < 0.95) {
        notes.push(`'${s.tool}' 성공률 ${round(s.successRate * 100)}% — 목표 95% 미달`);
        nextActions.push({ tool: 'devkit-observe', input: { view: 'failures', tool: s.tool }, why: `${s.tool} 실패 원인 확인` });
      }
      if (s.avgConfidence !== null && s.avgConfidence < 0.85) {
        notes.push(`'${s.tool}' 평균 confidence ${round(s.avgConfidence)} — 목표 0.85 미달. 분석 로직 개선 대상`);
      }
    }
  }

  if (wantsLeases) {
    const leases = activeLeases();
    data.leases = leases.map((l) => ({
      resourceKey: l.resourceKey,
      ownerAgent: l.ownerAgent,
      runId: l.runId,
      expiresInSec: Math.max(0, Math.round((l.expiresAt - Date.now()) / 1000)),
    }));
    evidence.push({ kind: 'query', source: 'sqlite:lease', text: '유효 임대 조회', rows: leases.length });
    if (leases.length > 0) {
      notes.push(`점유 중인 자원 ${leases.length}개 — 같은 자원을 쓰는 툴은 대기하거나 순서를 바꾸세요`);
    }
  }

  if (wantsTools) {
    data.tools = listTools().map((t) => ({
      name: t.manifest.name,
      version: t.manifest.version,
      summary: t.manifest.summary,
      sideEffects: t.manifest.sideEffects,
      concurrency: t.manifest.concurrency.mode,
      requiresApproval: t.manifest.requiresApproval,
    }));
    evidence.push({ kind: 'command', command: 'registry.listTools()', exitCode: 0, excerpt: `${(data.tools as unknown[]).length}개 툴 등록됨` });
  }

  if (wantsFailures) {
    const failures = listRuns({ limit: input.limit, status: 'error', tool: input.tool, sinceMs });
    const byCode = new Map<string, number>();
    for (const f of failures) byCode.set(f.error_code ?? 'UNKNOWN', (byCode.get(f.error_code ?? 'UNKNOWN') ?? 0) + 1);
    data.failures = [...byCode.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => ({ errorCode: code, count, sampleRunId: failures.find((f) => (f.error_code ?? 'UNKNOWN') === code)?.run_id }));
    evidence.push({ kind: 'query', source: 'sqlite:runs', text: "status='error' 실행 집계", rows: failures.length });

    for (const f of failures.slice(0, 3)) {
      unresolved.push({
        reason: 'ledger에는 에러 코드만 남습니다(입력 원문 미저장)',
        at: `${f.tool} / ${f.error_code}`,
        hint: `재현하려면 --record-input 으로 다시 실행하거나 ~/.devkit/runs/*.jsonl 에서 runId ${f.run_id} 를 찾으세요`,
      });
    }
  }

  if (input.view === 'summary') {
    const runs = (data.runs ?? []) as Array<{ status: string }>;
    data.summary = {
      windowHours: input.sinceHours,
      totalRuns: runs.length,
      running: runs.filter((r) => r.status === 'running').length,
      failed: runs.filter((r) => r.status === 'error').length,
      activeLeases: (data.leases as unknown[])?.length ?? 0,
      registeredTools: (data.tools as unknown[])?.length ?? 0,
    };
  }

  data.notes = notes;

  return {
    data,
    evidence,
    unresolved: unresolved.length ? unresolved : undefined,
    nextActions: nextActions.length ? nextActions : undefined,
    confidence: 1.0, // ledger 직접 조회이므로 추정이 없다
  };
}

function shapeRun(r: ReturnType<typeof listRuns>[number]) {
  return {
    runId: r.run_id,
    tool: r.tool,
    version: r.tool_version,
    agentId: r.agent_id,
    status: r.status,
    startedAt: new Date(r.started_at).toISOString(),
    durationMs: r.duration_ms,
    cacheHit: r.cache_hit === 1,
    confidence: r.confidence,
    errorCode: r.error_code,
    repo: r.repo,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
