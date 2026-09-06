/**
 * Raycast 확장의 데몬 접근 계층.
 *
 * Raycast를 띄우지 않고 검증하려고 확장을 두 겹으로 나눠 뒀다 — 이 파일이 검증하는
 * `raycast/src/dkc.ts`에는 @raycast/api가 들어있지 않다. 여기서 잡으려는 사고는 두 가지다.
 *   1) 소켓 경로 규칙이 본체(`paths.ts`)와 어긋나 "Raycast에서만 연결이 안 되는" 상태
 *   2) 목록 경로가 값을 실어오는 것 — 목록은 메타데이터만 오가야 한다 (스펙 §4.3)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { start } from '#config/daemon.ts';
import { socketPath as corePath } from '#config/paths.ts';
import { invalidatePolicy } from '#config/api.ts';
import { reset } from '#config/cache.ts';
import {
  DkcError,
  getStatus,
  getValue,
  listKeys,
  searchKeys,
  socketPath,
  subtitleOf,
} from '../raycast/src/dkc.ts';

let store = '';
let sock = '';

const PUBLIC = `items:
  - key: "ORDER_SERVICE_HOST"
    resource_type: "endpoint"
    alias: ["주문 서비스"]
    desc: "주문 도메인 게이트웨이"
    value:
      prod: "order-svc.internal"
      dev: "order-svc.dev.internal"
  - key: "EMPTY_KEY"
    alias: ["빈 항목"]
    value:
      dev: null
`;

before(() => {
  store = mkdtempSync(join(tmpdir(), 'dkc-ray-'));
  mkdirSync(join(store, 'config'), { recursive: true });
  writeFileSync(join(store, 'config', 'public.yaml'), PUBLIC);
  sock = join(store, 'd.sock'); // UDS 경로는 macOS에서 104바이트 제한이 있다
  process.env.DKC_STORE = store;
  delete process.env.DKC_POLICY;
  invalidatePolicy();
  reset();
});

after(() => {
  if (store) rmSync(store, { recursive: true, force: true });
});

test('소켓 경로 규칙이 본체와 어긋나지 않는다', () => {
  const before = process.env.DKC_SOCKET;
  try {
    delete process.env.DKC_SOCKET;
    assert.equal(socketPath(), corePath(), '자동 탐지 경로가 같아야 한다');

    process.env.DKC_SOCKET = '/tmp/custom-dkc.sock';
    assert.equal(socketPath(), corePath(), 'DKC_SOCKET도 같이 따라야 한다');

    assert.equal(socketPath('/tmp/override.sock'), '/tmp/override.sock', '설정값이 환경변수보다 우선한다');
  } finally {
    if (before === undefined) delete process.env.DKC_SOCKET;
    else process.env.DKC_SOCKET = before;
  }
});

test('데몬이 없으면 고칠 방법이 담긴 에러를 준다', async () => {
  await assert.rejects(
    () => getStatus({ socket: join(store, 'nope.sock'), timeoutMs: 500 }),
    (err: DkcError) => {
      assert.equal(err.code, 'DAEMON_UNAVAILABLE');
      assert.match(err.hint ?? '', /dkc daemon start/);
      return true;
    },
  );
});

test('목록과 검색은 값을 실어오지 않는다 — 값은 고른 뒤에만 가져온다', async () => {
  const h = await start({ socket: sock, quiet: true });
  try {
    const all = await listKeys({ socket: sock });
    assert.deepEqual(all.map((h2) => h2.key), ['EMPTY_KEY', 'ORDER_SERVICE_HOST']);
    assert.equal(JSON.stringify(all).includes('order-svc'), false, '목록 응답에 값이 있으면 안 된다');

    const hits = await searchKeys('주문 서비스', { socket: sock });
    assert.equal(hits[0].key, 'ORDER_SERVICE_HOST');
    assert.equal(JSON.stringify(hits).includes('order-svc'), false, '검색 응답에 값이 있으면 안 된다');
    assert.equal(subtitleOf(hits[0]), '주문 서비스 — 주문 도메인 게이트웨이');
  } finally {
    await h.close();
  }
});

test('값은 env를 지정해 하나씩 가져온다', async () => {
  const h = await start({ socket: sock, quiet: true });
  try {
    const dev = await getValue('ORDER_SERVICE_HOST', 'dev', { socket: sock });
    assert.equal(dev.value, 'order-svc.dev.internal');
    assert.equal(dev.status, 'ok');

    const prod = await getValue('ORDER_SERVICE_HOST', 'prod', { socket: sock });
    assert.equal(prod.value, 'order-svc.internal');

    // 미설정과 정의 없음은 다른 상태다 (스펙 §4.8). 확장은 둘을 다르게 안내해야 한다.
    const empty = await getValue('EMPTY_KEY', 'dev', { socket: sock });
    assert.equal(empty.status, 'unset');
    assert.equal(empty.value, null);

    await assert.rejects(
      () => getValue('NOPE', 'dev', { socket: sock }),
      (err: DkcError) => err.code === 'KEY_NOT_FOUND',
    );
  } finally {
    await h.close();
  }
});
