/**
 * 임대 동시성 테스트 (요구사항 3의 핵심 검증).
 *
 * 단일 프로세스 안의 경합은 SQLite 락 덕분에 쉽게 통과한다.
 * 진짜로 확인해야 할 건 **별도 프로세스 8개가 동시에 같은 자원을 잡으려 할 때
 * 정확히 1개만 성공하는가**이다. 여러 에이전트가 각자 프로세스로 도는 실제 상황이 그렇다.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '#core/paths.ts';

let home: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'devkit-lease-'));
  process.env.DEVKIT_HOME = home;
});

after(() => rmSync(home, { recursive: true, force: true }));

test('같은 자원에 대해 한 프로세스만 성공한다', async () => {
  const script = join(home, 'grab.ts');
  writeFileSync(
    script,
    `import { tryAcquire } from '${join(repoRoot(), 'packages/core/src/lease.ts')}';
     const got = tryAcquire('gradle:my-service', process.argv[2], 'run-' + process.argv[2]);
     console.log(got ? 'ACQUIRED' : 'BUSY');`,
  );

  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      new Promise<string>((resolve) => {
        setTimeout(() => {
          resolve(
            execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', script, `A${i}`], {
              encoding: 'utf8',
              env: { ...process.env, DEVKIT_HOME: home },
            }).trim(),
          );
        }, 0);
      }),
    ),
  );

  const acquired = results.filter((r) => r === 'ACQUIRED');
  assert.equal(acquired.length, 1, `정확히 1개만 획득해야 하는데 ${acquired.length}개가 획득했습니다`);
});

test('만료된 임대는 다음 획득 시도가 회수한다', async () => {
  const { tryAcquire, inspect } = await import('#core/lease.ts');
  assert.ok(tryAcquire('short-lived', 'A1', 'run-1', 1)); // TTL 1ms
  await new Promise((r) => setTimeout(r, 20));
  const taken = tryAcquire('short-lived', 'A2', 'run-2');
  assert.ok(taken, '만료된 임대를 회수하지 못했습니다');
  assert.equal(inspect('short-lived')?.ownerAgent, 'A2');
});

test('소유자가 아니면 해제할 수 없다', async () => {
  const { tryAcquire, release, inspect } = await import('#core/lease.ts');
  tryAcquire('owned', 'A1', 'run-1');
  assert.equal(release('owned', 'run-2'), false, '다른 runId가 남의 임대를 해제했습니다');
  assert.equal(inspect('owned')?.ownerAgent, 'A1');
  assert.equal(release('owned', 'run-1'), true);
});

test('acquireAll은 실패 시 이미 잡은 것을 모두 되돌린다', async () => {
  const { tryAcquire, acquireAll, inspect } = await import('#core/lease.ts');
  tryAcquire('res-b', 'other', 'run-other'); // B를 먼저 점유

  await assert.rejects(
    () => acquireAll(['res-a', 'res-b'], 'A1', 'run-1'),
    (err: { code?: string }) => err.code === 'LEASE_BUSY',
  );
  assert.equal(inspect('res-a'), null, 'res-a가 롤백되지 않고 남아 있습니다');
});
