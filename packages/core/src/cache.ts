/**
 * 결과 캐시 (설계원칙 P6: 결정적 툴은 캐시할 수 있다).
 *
 * 캐시 키에 commitSha를 넣는다. 워킹트리가 dirty면 캐시를 아예 쓰지 않는다 —
 * 낡은 분석 결과를 제공하는 것이 캐시 미스보다 훨씬 나쁘기 때문이다 (plan.md §14).
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { db, now } from './db.ts';

export type CacheKeyParts = {
  tool: string;
  toolVersion: string;
  input: unknown;
  /** by-commit 결정성 툴이면 필수. 없으면 캐시하지 않는다. */
  commitSha?: string;
};

export function cacheKey(parts: CacheKeyParts): string {
  const raw = JSON.stringify([parts.tool, parts.toolVersion, parts.commitSha ?? '', parts.input ?? null]);
  return createHash('sha256').update(raw).digest('hex');
}

export function get<T>(key: string): T | null {
  const row = db().prepare('SELECT value, expires_at FROM cache WHERE key = ?').get(key) as
    | { value: string; expires_at: number | null }
    | undefined;
  if (!row) return null;
  if (row.expires_at !== null && row.expires_at < now()) {
    db().prepare('DELETE FROM cache WHERE key = ?').run(key);
    return null;
  }
  try {
    return JSON.parse(row.value) as T;
  } catch {
    db().prepare('DELETE FROM cache WHERE key = ?').run(key);
    return null;
  }
}

export function set(key: string, tool: string, value: unknown, ttlMs?: number): void {
  db()
    .prepare(
      `INSERT INTO cache (key, tool, value, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at,
                                      expires_at = excluded.expires_at`,
    )
    .run(key, tool, JSON.stringify(value), now(), ttlMs ? now() + ttlMs : null);
}

export function invalidateTool(tool: string): number {
  return Number(db().prepare('DELETE FROM cache WHERE tool = ?').run(tool).changes);
}

export function clear(): number {
  return Number(db().prepare('DELETE FROM cache').run().changes);
}

export type RepoState = { commitSha: string | null; dirty: boolean };

/**
 * 저장소의 캐시 유효성 상태.
 * dirty(커밋 안 된 변경 있음)면 commitSha를 null로 만들어 캐시를 비활성화한다.
 */
export function repoState(repoPath: string): RepoState {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty = status !== '';
    return { commitSha: dirty ? null : sha, dirty };
  } catch {
    // git 저장소가 아니면 캐시하지 않는다.
    return { commitSha: null, dirty: false };
  }
}
