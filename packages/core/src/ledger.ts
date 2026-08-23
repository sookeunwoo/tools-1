/**
 * 실행 기록 (plan.md §7.1).
 *
 * JSONL이 진실 원천(append-only, jq로 읽힘), SQLite는 조회용 파생 인덱스다.
 * SQLite가 깨져도 JSONL에서 재생성할 수 있다.
 *
 * 입력 원문은 저장하지 않고 해시만 남긴다 — 시크릿/PII 유출 방지.
 * 원문이 필요하면 --record-input으로 명시 옵트인.
 *
 * 필드명은 OpenTelemetry 호환(traceId/spanId/parentSpanId)으로 맞춰
 * 나중에 OTel 콜렉터로 내보낼 때 재작업이 없게 한다.
 */

import { appendFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { db, now } from './db.ts';
import { runsLogPath } from './paths.ts';
import { redactDeep } from './secrets.ts';
import { localISO } from './time.ts';

export type RunStatus = 'running' | 'ok' | 'error' | 'denied' | 'timeout';

export type RunStart = {
  runId: string;
  traceId: string;
  parentSpanId?: string;
  agentId: string;
  tool: string;
  toolVersion: string;
  repo?: string;
  input: unknown;
  idempotencyKey?: string;
  recordInput?: boolean;
};

export type RunEnd = {
  runId: string;
  status: RunStatus;
  cacheHit?: boolean;
  evidenceCount?: number;
  confidence?: number;
  errorCode?: string;
  leases?: string[];
  result?: unknown;
};

export function newRunId(): string {
  return randomUUID();
}

export function hashInput(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input ?? null)).digest('hex').slice(0, 16);
}

export function startRun(start: RunStart): void {
  const startedAt = now();
  db()
    .prepare(
      `INSERT INTO runs (run_id, trace_id, parent_span_id, agent_id, tool, tool_version, repo,
                         input_hash, idempotency_key, started_at, status, cache_hit)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 0)`,
    )
    .run(
      start.runId,
      start.traceId,
      start.parentSpanId ?? null,
      start.agentId,
      start.tool,
      start.toolVersion,
      start.repo ?? null,
      hashInput(start.input),
      start.idempotencyKey ?? null,
      startedAt,
    );

  writeEvent({
    event: 'run.start',
    ts: localISO(new Date(startedAt)),
    runId: start.runId,
    traceId: start.traceId,
    parentSpanId: start.parentSpanId,
    agentId: start.agentId,
    tool: start.tool,
    toolVersion: start.toolVersion,
    repo: start.repo,
    inputHash: hashInput(start.input),
    input: start.recordInput ? redactDeep(start.input) : undefined,
  });
}

export function endRun(end: RunEnd): void {
  const endedAt = now();
  const row = db().prepare('SELECT started_at, tool, trace_id FROM runs WHERE run_id = ?').get(end.runId) as
    | { started_at: number; tool: string; trace_id: string }
    | undefined;
  const durationMs = row ? endedAt - row.started_at : null;

  db()
    .prepare(
      `UPDATE runs SET ended_at = ?, duration_ms = ?, status = ?, cache_hit = ?,
                       evidence_count = ?, confidence = ?, error_code = ?, leases = ?
       WHERE run_id = ?`,
    )
    .run(
      endedAt,
      durationMs,
      end.status,
      end.cacheHit ? 1 : 0,
      end.evidenceCount ?? null,
      end.confidence ?? null,
      end.errorCode ?? null,
      end.leases?.length ? JSON.stringify(end.leases) : null,
      end.runId,
    );

  writeEvent({
    event: 'run.end',
    ts: localISO(new Date(endedAt)),
    runId: end.runId,
    traceId: row?.trace_id,
    tool: row?.tool,
    status: end.status,
    durationMs,
    cacheHit: end.cacheHit ?? false,
    evidenceCount: end.evidenceCount,
    confidence: end.confidence,
    errorCode: end.errorCode,
    leases: end.leases,
  });
}

/** 멱등성: 같은 (tool, key)로 이미 성공한 실행이 있으면 그 runId를 돌려준다. */
export function findIdempotent(tool: string, key: string): string | null {
  const row = db()
    .prepare(`SELECT run_id FROM runs WHERE tool = ? AND idempotency_key = ? AND status = 'ok'`)
    .get(tool, key) as { run_id: string } | undefined;
  return row?.run_id ?? null;
}

export type RunRow = {
  run_id: string;
  agent_id: string;
  tool: string;
  tool_version: string;
  status: RunStatus;
  started_at: number;
  duration_ms: number | null;
  cache_hit: number;
  confidence: number | null;
  error_code: string | null;
  repo: string | null;
};

export function listRuns(opts: { limit?: number; status?: RunStatus; tool?: string; sinceMs?: number } = {}): RunRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.status) (clauses.push('status = ?'), params.push(opts.status));
  if (opts.tool) (clauses.push('tool = ?'), params.push(opts.tool));
  if (opts.sinceMs) (clauses.push('started_at >= ?'), params.push(now() - opts.sinceMs));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db()
    .prepare(
      `SELECT run_id, agent_id, tool, tool_version, status, started_at, duration_ms,
              cache_hit, confidence, error_code, repo
       FROM runs ${where} ORDER BY started_at DESC LIMIT ?`,
    )
    .all(...params, opts.limit ?? 50) as RunRow[];
}

export type ToolStat = {
  tool: string;
  calls: number;
  ok: number;
  errors: number;
  successRate: number;
  p50Ms: number | null;
  p95Ms: number | null;
  cacheHitRate: number;
  avgConfidence: number | null;
};

export function toolStats(sinceMs: number): ToolStat[] {
  const rows = db()
    .prepare(
      `SELECT tool, status, duration_ms, cache_hit, confidence
       FROM runs WHERE started_at >= ? AND status != 'running'`,
    )
    .all(now() - sinceMs) as Array<{
    tool: string;
    status: string;
    duration_ms: number | null;
    cache_hit: number;
    confidence: number | null;
  }>;

  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = grouped.get(row.tool) ?? [];
    list.push(row);
    grouped.set(row.tool, list);
  }

  return [...grouped.entries()]
    .map(([tool, list]) => {
      const durations = list.map((r) => r.duration_ms).filter((d): d is number => d !== null).sort((a, b) => a - b);
      const ok = list.filter((r) => r.status === 'ok').length;
      const confidences = list.map((r) => r.confidence).filter((c): c is number => c !== null);
      return {
        tool,
        calls: list.length,
        ok,
        errors: list.length - ok,
        successRate: list.length ? ok / list.length : 0,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        cacheHitRate: list.length ? list.filter((r) => r.cache_hit === 1).length / list.length : 0,
        avgConfidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null,
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function writeEvent(event: Record<string, unknown>): void {
  const clean = redactDeep(event);
  const line = JSON.stringify(clean, (_k, v) => (v === undefined ? undefined : v));
  appendFileSync(runsLogPath(), line + '\n', 'utf8');
}
