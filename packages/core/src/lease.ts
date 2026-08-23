/**
 * 배타 자원 임대 (plan.md §5) — 동시성 모델의 핵심.
 *
 * 여러 에이전트가 같은 Gradle 데몬/DB 커넥션/코드 인덱스를 동시에 건드리면
 * 깨지는 자원을 TTL 기반 임대로 보호한다.
 *
 * 설계 요점:
 *   - 획득은 단일 UPSERT로 원자적(CAS). SELECT 후 INSERT 하는 경합 구간이 없다.
 *   - TTL + 하트비트. 에이전트가 죽어도 만료 후 자동 회수되므로 GC 프로세스가 없다.
 *   - 다중 획득은 자원 키 사전순으로만 → 데드락 원천 차단.
 */

import { db, now } from './db.ts';
import { DevkitError } from './errors.ts';

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 30 * 1000;

export type Lease = {
  resourceKey: string;
  ownerAgent: string;
  runId: string;
  expiresAt: number;
};

export type AcquireOptions = {
  ttlMs?: number;
  /** 점유 중일 때 최대 대기 시간. 0이면 즉시 실패. */
  waitMs?: number;
};

/**
 * 자원을 획득한다. 이미 유효한 임대가 있으면 waitMs 동안 재시도한다.
 * 만료된 임대는 획득 시점에 함께 회수된다(스윕 프로세스 불필요).
 */
export async function acquire(
  resourceKey: string,
  ownerAgent: string,
  runId: string,
  opts: AcquireOptions = {},
): Promise<Lease> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const waitMs = opts.waitMs ?? 0;
  const deadline = now() + waitMs;

  for (;;) {
    const lease = tryAcquire(resourceKey, ownerAgent, runId, ttlMs);
    if (lease) return lease;

    if (now() >= deadline) {
      const holder = inspect(resourceKey);
      throw new DevkitError({
        code: 'LEASE_BUSY',
        message: `자원 '${resourceKey}'를 ${holder?.ownerAgent ?? '다른 에이전트'}가 점유 중입니다`,
        hint: holder
          ? `${Math.max(0, Math.round((holder.expiresAt - now()) / 1000))}초 후 만료 예정입니다. devkit-observe로 현황을 확인하세요.`
          : '잠시 후 다시 시도하세요.',
        retryable: true,
        fixCommand: `dk run devkit-observe --input '{"view":"leases"}'`,
      });
    }
    await sleep(Math.min(250, Math.max(0, deadline - now())));
  }
}

/** 한 번만 시도한다. 실패하면 null. */
export function tryAcquire(resourceKey: string, ownerAgent: string, runId: string, ttlMs = DEFAULT_TTL_MS): Lease | null {
  const ts = now();
  const expiresAt = ts + ttlMs;

  // 비어 있거나(INSERT) 만료됐을 때(DO UPDATE ... WHERE)만 성공한다.
  // 유효한 임대가 있으면 WHERE가 걸러서 changes = 0이 된다.
  const result = db()
    .prepare(
      `INSERT INTO lease (resource_key, owner_agent, run_id, acquired_at, expires_at, heartbeat_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(resource_key) DO UPDATE SET
         owner_agent = excluded.owner_agent,
         run_id      = excluded.run_id,
         acquired_at = excluded.acquired_at,
         expires_at  = excluded.expires_at,
         heartbeat_at = excluded.heartbeat_at
       WHERE lease.expires_at < ?`,
    )
    .run(resourceKey, ownerAgent, runId, ts, expiresAt, ts, ts);

  if (Number(result.changes) === 0) return null;
  return { resourceKey, ownerAgent, runId, expiresAt };
}

/**
 * 여러 자원을 all-or-nothing으로 획득한다.
 * 키를 사전순 정렬해 획득 순서를 전역 고정 → 데드락이 생길 수 없다.
 */
export async function acquireAll(
  resourceKeys: string[],
  ownerAgent: string,
  runId: string,
  opts: AcquireOptions = {},
): Promise<Lease[]> {
  const ordered = [...new Set(resourceKeys)].sort();
  const held: Lease[] = [];
  try {
    for (const key of ordered) held.push(await acquire(key, ownerAgent, runId, opts));
    return held;
  } catch (err) {
    for (const lease of held) release(lease.resourceKey, lease.runId);
    throw err;
  }
}

/** 소유자만 갱신할 수 있다. 다른 에이전트가 회수해 간 경우 false. */
export function heartbeat(resourceKey: string, runId: string, ttlMs = DEFAULT_TTL_MS): boolean {
  const ts = now();
  const result = db()
    .prepare('UPDATE lease SET heartbeat_at = ?, expires_at = ? WHERE resource_key = ? AND run_id = ?')
    .run(ts, ts + ttlMs, resourceKey, runId);
  return Number(result.changes) > 0;
}

export function release(resourceKey: string, runId: string): boolean {
  const result = db().prepare('DELETE FROM lease WHERE resource_key = ? AND run_id = ?').run(resourceKey, runId);
  return Number(result.changes) > 0;
}

export function releaseAll(leases: Lease[]): void {
  for (const lease of leases) release(lease.resourceKey, lease.runId);
}

export function inspect(resourceKey: string): Lease | null {
  const row = db()
    .prepare('SELECT resource_key, owner_agent, run_id, expires_at FROM lease WHERE resource_key = ?')
    .get(resourceKey) as { resource_key: string; owner_agent: string; run_id: string; expires_at: number } | undefined;
  if (!row) return null;
  return { resourceKey: row.resource_key, ownerAgent: row.owner_agent, runId: row.run_id, expiresAt: row.expires_at };
}

/** 유효한 임대만 (만료된 것은 제외). devkit-observe가 쓴다. */
export function activeLeases(): Lease[] {
  const rows = db()
    .prepare('SELECT resource_key, owner_agent, run_id, expires_at FROM lease WHERE expires_at >= ? ORDER BY resource_key')
    .all(now()) as Array<{ resource_key: string; owner_agent: string; run_id: string; expires_at: number }>;
  return rows.map((r) => ({
    resourceKey: r.resource_key,
    ownerAgent: r.owner_agent,
    runId: r.run_id,
    expiresAt: r.expires_at,
  }));
}

/** 만료 임대 정리. 획득 경로에서 자동 회수되므로 운영상 필수는 아니고 `dk doctor`용. */
export function sweep(): number {
  return Number(db().prepare('DELETE FROM lease WHERE expires_at < ?').run(now()).changes);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
