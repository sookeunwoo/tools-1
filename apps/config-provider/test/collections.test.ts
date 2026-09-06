/**
 * 컬렉션 — 키를 묶는 정리 단위.
 *
 * 여기서 지켜야 하는 불변식은 세 가지다.
 *   1) 컬렉션을 지워도 key는 살아있다 (정리 도구가 데이터를 지우면 안 된다)
 *   2) 한 key는 최대 한 컬렉션에 속한다 (드래그로 옮기면 원래 자리에서 빠진다)
 *   3) 항목 파일(public/secret)은 컬렉션 편집으로 절대 바뀌지 않는다
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handle } from '#config/api.ts';
import { reload, reset } from '#config/cache.ts';
import type { Caller } from '#config/policy.ts';

let store = '';
const owner: Caller = { kind: 'owner', agentId: 'owner' };
const agent: Caller = { kind: 'agent', agentId: 'claude-code' };

const PUBLIC = `items:
  - key: "ORDER_SERVICE_HOST"
    alias: ["주문 서비스"]
    value:
      prod: "order-svc.internal"
      dev: "order-svc.dev.internal"
  - key: "PAYMENT_API_KEY"
    alias: ["결제 키"]
    value:
      prod: "live_x"
      dev: "test_x"
  - key: "FEATURE_FLAG_HOST"
    value:
      dev: "flags.dev"
`;

before(async () => {
  store = mkdtempSync(join(tmpdir(), 'dkc-col-'));
  mkdirSync(join(store, 'config'), { recursive: true });
  writeFileSync(join(store, 'config', 'public.yaml'), PUBLIC);
  process.env.DKC_STORE = store;
  process.env.DKC_POLICY = join(store, 'policy.yaml');
  reset();
  await reload();
});

after(() => {
  if (store) rmSync(store, { recursive: true, force: true });
});

function req(method: string, path: string, body?: unknown, caller: Caller = owner) {
  return handle({ method, path, query: new URLSearchParams(''), body: body ?? null, caller });
}
const data = (r: { body: unknown }) => (r.body as { data: any }).data;

test('컬렉션이 없으면 모든 key가 미분류다', async () => {
  const r = await req('GET', '/collections');
  assert.deepEqual(data(r).collections, []);
  assert.deepEqual(data(r).uncategorized.sort(), ['FEATURE_FLAG_HOST', 'ORDER_SERVICE_HOST', 'PAYMENT_API_KEY']);
});

test('컬렉션을 만들고 key를 옮기면 미분류에서 빠진다', async () => {
  await req('POST', '/collections', { name: '결제' });
  const r = await req('PUT', '/collections/결제/keys/PAYMENT_API_KEY');
  assert.deepEqual(data(r).collections, [{ name: '결제', keys: ['PAYMENT_API_KEY'] }]);
  assert.equal(data(r).uncategorized.includes('PAYMENT_API_KEY'), false);
});

test('한 key는 최대 한 컬렉션에 속한다 — 옮기면 원래 자리에서 빠진다', async () => {
  await req('POST', '/collections', { name: '주문' });
  const r = await req('PUT', '/collections/주문/keys/PAYMENT_API_KEY');
  const byName = Object.fromEntries(data(r).collections.map((c: any) => [c.name, c.keys]));
  assert.deepEqual(byName['주문'], ['PAYMENT_API_KEY']);
  assert.deepEqual(byName['결제'], []);
});

test('이름은 유일하다', async () => {
  const r = await req('POST', '/collections', { name: '주문' });
  assert.equal(r.status, 409);
  assert.equal((r.body as any).error.code, 'COLLECTION_EXISTS');
});

test('빈 이름은 거부한다', async () => {
  assert.equal((await req('POST', '/collections', { name: '   ' })).status, 400);
});

test('없는 key는 컬렉션에 넣을 수 없다', async () => {
  const r = await req('PUT', '/collections/주문/keys/NOPE');
  assert.equal(r.status, 404);
});

test('없는 컬렉션은 404다', async () => {
  assert.equal((await req('PUT', '/collections/없음/keys/PAYMENT_API_KEY')).status, 404);
  assert.equal((await req('DELETE', '/collections/없음')).status, 404);
});

test('이름을 바꿔도 안의 key는 그대로다', async () => {
  const r = await req('PUT', '/collections/주문', { name: '주문 도메인' });
  const byName = Object.fromEntries(data(r).collections.map((c: any) => [c.name, c.keys]));
  assert.deepEqual(byName['주문 도메인'], ['PAYMENT_API_KEY']);
  assert.equal('주문' in byName, false);
});

test('keys를 통째로 교체하면 다른 컬렉션에서 데려온 key는 그쪽에서 빠진다', async () => {
  const r = await req('PUT', '/collections/결제', { keys: ['PAYMENT_API_KEY', 'ORDER_SERVICE_HOST'] });
  const byName = Object.fromEntries(data(r).collections.map((c: any) => [c.name, c.keys]));
  assert.deepEqual(byName['결제'].sort(), ['ORDER_SERVICE_HOST', 'PAYMENT_API_KEY']);
  assert.deepEqual(byName['주문 도메인'], []);
});

test('컬렉션을 지워도 key는 살아있다 — 미분류로 돌아갈 뿐이다', async () => {
  const r = await req('DELETE', '/collections/결제');
  assert.equal(data(r).collections.some((c: any) => c.name === '결제'), false);
  assert.deepEqual(data(r).uncategorized.sort(), ['FEATURE_FLAG_HOST', 'ORDER_SERVICE_HOST', 'PAYMENT_API_KEY']);
  const items = data(await req('GET', '/items'));
  assert.equal(items.items.length, 3, '항목 자체는 그대로여야 한다');
});

test('컬렉션 편집은 항목 파일을 건드리지 않는다', async () => {
  const before = readFileSync(join(store, 'config', 'public.yaml'), 'utf8');
  await req('POST', '/collections', { name: '임시' });
  await req('PUT', '/collections/임시/keys/FEATURE_FLAG_HOST');
  assert.equal(readFileSync(join(store, 'config', 'public.yaml'), 'utf8'), before);
  assert.ok(existsSync(join(store, 'collections.yaml')), 'collections.yaml에만 쓴다');
});

test('에이전트는 컬렉션을 바꿀 수 없다 — 정리는 사람의 일이다', async () => {
  const r = await req('POST', '/collections', { name: '에이전트' }, agent);
  assert.equal(r.status, 403);
  assert.equal((await req('DELETE', '/collections/임시', null, agent)).status, 403);
});

test('파일을 손으로 고쳐 없는 key가 남아도 조회에서 떨어진다', async () => {
  writeFileSync(join(store, 'collections.yaml'), 'collections:\n  - name: "손편집"\n    keys:\n      - GONE_KEY\n      - FEATURE_FLAG_HOST\n');
  const r = await req('GET', '/collections');
  const c = data(r).collections.find((x: any) => x.name === '손편집');
  assert.deepEqual(c.keys, ['FEATURE_FLAG_HOST']);
});
