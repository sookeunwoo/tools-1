/**
 * SQLite 접근 (ADR-003).
 *
 * Node 24 내장 node:sqlite를 쓴다 — 네이티브 빌드가 없어서 `npm i` 실패로
 * 막히는 일이 없다 (설계원칙 P7 = 제약 2의 실질 조건).
 *
 * WAL 모드로 다중 프로세스 동시 접근을 허용한다. 데몬은 두지 않는다.
 */

import { DatabaseSync } from 'node:sqlite';
import { dbPath } from './paths.ts';
import { DevkitError } from './errors.ts';

let cached: DatabaseSync | null = null;
let cachedPath: string | null = null;

export function db(): DatabaseSync {
  const path = dbPath();
  if (cached && cachedPath === path) return cached;
  if (cached) cached.close();

  let handle: DatabaseSync;
  try {
    handle = new DatabaseSync(path);
  } catch (err) {
    throw new DevkitError({
      code: 'DB_OPEN_FAILED',
      message: `SQLite를 열 수 없습니다: ${path} (${(err as Error).message})`,
      hint: 'DEVKIT_HOME 경로 권한을 확인하세요.',
      retryable: false,
      fixCommand: 'dk doctor',
    });
  }

  // busy_timeout: 다른 에이전트가 라이터를 잡고 있을 때 즉시 실패하지 않고 대기한다.
  handle.exec('PRAGMA journal_mode = WAL');
  handle.exec('PRAGMA busy_timeout = 5000');
  handle.exec('PRAGMA foreign_keys = ON');
  migrate(handle);

  cached = handle;
  cachedPath = path;
  return handle;
}

export function closeDb(): void {
  if (cached) cached.close();
  cached = null;
  cachedPath = null;
}

function migrate(handle: DatabaseSync): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id         TEXT PRIMARY KEY,
      trace_id       TEXT NOT NULL,
      parent_span_id TEXT,
      agent_id       TEXT NOT NULL,
      tool           TEXT NOT NULL,
      tool_version   TEXT NOT NULL,
      repo           TEXT,
      input_hash     TEXT NOT NULL,
      idempotency_key TEXT,
      started_at     INTEGER NOT NULL,
      ended_at       INTEGER,
      duration_ms    INTEGER,
      status         TEXT NOT NULL,
      cache_hit      INTEGER NOT NULL DEFAULT 0,
      evidence_count INTEGER,
      confidence     REAL,
      error_code     TEXT,
      leases         TEXT,
      result_json    TEXT
    );
    CREATE INDEX IF NOT EXISTS runs_started_idx ON runs (started_at DESC);
    CREATE INDEX IF NOT EXISTS runs_tool_idx    ON runs (tool, started_at DESC);
    CREATE INDEX IF NOT EXISTS runs_status_idx  ON runs (status, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS runs_idem_idx
      ON runs (tool, idempotency_key) WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS lease (
      resource_key TEXT PRIMARY KEY,
      owner_agent  TEXT NOT NULL,
      run_id       TEXT NOT NULL,
      acquired_at  INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cache (
      key        TEXT PRIMARY KEY,
      tool       TEXT NOT NULL,
      value      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS cache_tool_idx ON cache (tool);
  `);
}

export function now(): number {
  return Date.now();
}
