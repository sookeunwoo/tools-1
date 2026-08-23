/**
 * 코드 인덱스 저장소 (plan.md §11.1).
 *
 * 저장소별 SQLite 파일(`~/.devkit/index/<repo>.db`)에 담는다.
 * 런타임 DB(ledger/lease/cache)와 **파일을 분리**해서, 인덱스가 커지거나 깨져도
 * 실행 기록에 영향이 없게 한다. 인덱스는 언제든 재생성 가능한 파생물이다.
 *
 * repo-map이 쓰고 trace-flow가 읽는다. 그 사이의 유일한 계약이다.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { devkitHome } from '#core/paths.ts';
import { DevkitError } from '#core/errors.ts';
import type { FileSymbols, ScanGap } from './types.ts';

export function indexPath(repo: string): string {
  const dir = join(devkitHome(), 'index');
  mkdirSync(dir, { recursive: true });
  return join(dir, `${repo.replace(/[^\w.-]/g, '_')}.db`);
}

export function openIndex(repo: string): DatabaseSync {
  const db = new DatabaseSync(indexPath(repo));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS types (
      name TEXT, kind TEXT, path TEXT, line INTEGER,
      annotations TEXT, supertypes TEXT, package TEXT
    );
    CREATE TABLE IF NOT EXISTS methods (
      type_name TEXT, name TEXT, path TEXT, line INTEGER, annotations TEXT
    );
    CREATE TABLE IF NOT EXISTS fields (
      type_name TEXT, name TEXT, field_type TEXT, line INTEGER
    );
    CREATE TABLE IF NOT EXISTS calls (
      type_name TEXT, method_name TEXT, receiver TEXT, callee TEXT, line INTEGER
    );
    CREATE TABLE IF NOT EXISTS endpoints (
      key TEXT, kind TEXT, type_name TEXT, method_name TEXT, path TEXT, line INTEGER
    );
    CREATE TABLE IF NOT EXISTS gaps (path TEXT, line INTEGER, reason TEXT, detail TEXT);

    CREATE INDEX IF NOT EXISTS types_name_idx    ON types (name);
    CREATE INDEX IF NOT EXISTS methods_type_idx  ON methods (type_name, name);
    CREATE INDEX IF NOT EXISTS fields_type_idx   ON fields (type_name);
    CREATE INDEX IF NOT EXISTS calls_owner_idx   ON calls (type_name, method_name);
    CREATE INDEX IF NOT EXISTS endpoints_key_idx ON endpoints (key);
  `);
  return db;
}

export type IndexMeta = { commitSha: string; indexedAt: string; toolVersion: string; fileCount: number };

export function writeIndex(repo: string, files: FileSymbols[], gaps: ScanGap[], meta: IndexMeta): void {
  const db = openIndex(repo);
  try {
    db.exec('BEGIN IMMEDIATE');
    for (const t of ['meta', 'types', 'methods', 'fields', 'calls', 'endpoints', 'gaps']) db.exec(`DELETE FROM ${t}`);

    const insMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [k, v] of Object.entries(meta)) insMeta.run(k, String(v));

    const insType = db.prepare('INSERT INTO types VALUES (?, ?, ?, ?, ?, ?, ?)');
    const insMethod = db.prepare('INSERT INTO methods VALUES (?, ?, ?, ?, ?)');
    const insField = db.prepare('INSERT INTO fields VALUES (?, ?, ?, ?)');
    const insCall = db.prepare('INSERT INTO calls VALUES (?, ?, ?, ?, ?)');
    const insEp = db.prepare('INSERT INTO endpoints VALUES (?, ?, ?, ?, ?, ?)');
    const insGap = db.prepare('INSERT INTO gaps VALUES (?, ?, ?, ?)');

    for (const f of files) {
      for (const t of f.types) {
        insType.run(t.name, t.kind, f.path, t.line, JSON.stringify(t.annotations), JSON.stringify(t.supertypes), f.packageName);
        for (const fd of t.fields) insField.run(t.name, fd.name, fd.type, fd.line);
        for (const m of t.methods) {
          insMethod.run(t.name, m.name, f.path, m.line, JSON.stringify(m.annotations));
          for (const c of m.calls) insCall.run(t.name, m.name, c.receiver, c.method, c.line);
        }
      }
      for (const e of f.endpoints) insEp.run(e.key, e.kind, e.typeName, e.methodName, f.path, e.line);
    }
    for (const g of gaps) insGap.run(g.path, g.line, g.reason, g.detail ?? null);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.close();
  }
}

// ── 조회 (trace-flow가 쓴다) ──────────────────────────────────────

export type IndexReader = ReturnType<typeof openReader>;

export function openReader(repo: string, expectedSha?: string) {
  const db = openIndex(repo);
  const meta = Object.fromEntries(
    (db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]),
  );

  if (!meta.commitSha) {
    db.close();
    throw new DevkitError({
      code: 'REPO_INDEX_MISSING',
      message: `'${repo}'의 코드 인덱스가 없습니다`,
      hint: '먼저 repo-map으로 인덱스를 생성하세요.',
      retryable: false,
      fixCommand: `dk run repo-map --input '{"repo":"${repo}"}'`,
    });
  }
  if (expectedSha && meta.commitSha !== expectedSha) {
    const stale = meta.commitSha;
    db.close();
    throw new DevkitError({
      code: 'REPO_INDEX_STALE',
      message: `인덱스가 커밋 ${stale} 기준인데 워킹트리는 ${expectedSha} 입니다`,
      hint: '인덱스를 재생성하세요.',
      retryable: true,
      fixCommand: `dk run repo-map --input '{"repo":"${repo}"}' --refresh`,
    });
  }

  const q = <T>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];

  return {
    meta,
    close: () => db.close(),
    endpoints: () => q<{ key: string; kind: string; type_name: string; method_name: string; path: string; line: number }>(
      'SELECT * FROM endpoints ORDER BY key'),
    findEndpoint: (key: string) => q<{ key: string; kind: string; type_name: string; method_name: string; path: string; line: number }>(
      'SELECT * FROM endpoints WHERE key = ? OR key LIKE ?', key, `%${key}%`),
    type: (name: string) => q<{ name: string; kind: string; path: string; line: number; annotations: string; supertypes: string }>(
      'SELECT * FROM types WHERE name = ?', name)[0],
    method: (type: string, name: string) => q<{ type_name: string; name: string; path: string; line: number; annotations: string }>(
      'SELECT * FROM methods WHERE type_name = ? AND name = ?', type, name)[0],
    fields: (type: string) => q<{ name: string; field_type: string; line: number }>(
      'SELECT * FROM fields WHERE type_name = ?', type),
    calls: (type: string, method: string) => q<{ receiver: string | null; callee: string; line: number }>(
      'SELECT receiver, callee, line FROM calls WHERE type_name = ? AND method_name = ?', type, method),
    implementors: (iface: string) => q<{ name: string; path: string }>(
      "SELECT name, path FROM types WHERE supertypes LIKE ?", `%"${iface}"%`),
    counts: () => ({
      types: (db.prepare('SELECT COUNT(*) c FROM types').get() as { c: number }).c,
      methods: (db.prepare('SELECT COUNT(*) c FROM methods').get() as { c: number }).c,
      endpoints: (db.prepare('SELECT COUNT(*) c FROM endpoints').get() as { c: number }).c,
      gaps: (db.prepare('SELECT COUNT(*) c FROM gaps').get() as { c: number }).c,
    }),
  };
}
