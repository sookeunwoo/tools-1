/** core 라이브러리 단위 테스트 — toml / schema / secrets 마스킹. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToml } from '#core/toml.ts';
import { validate } from '#core/schema.ts';
import { redact } from '#core/secrets.ts';
import { localDate, localISO } from '#core/time.ts';

test('TOML: 테이블·타입·주석을 파싱한다', () => {
  const parsed = parseToml(`
    default_profile = "company"   # 주석은 무시
    [repos.my-service]
    path = "~/IdeaProjects/my-service"
    lang = ["kotlin", "java"]
    readonly = true
    timeout = 3000
  `);
  assert.equal(parsed.default_profile, 'company');
  const repo = (parsed.repos as any)['my-service'];
  assert.deepEqual(repo.lang, ['kotlin', 'java']);
  assert.equal(repo.readonly, true);
  assert.equal(repo.timeout, 3000);
});

test('TOML: 문자열 안의 #은 주석이 아니다', () => {
  const parsed = parseToml('url = "http://x/#frag"');
  assert.equal(parsed.url, 'http://x/#frag');
});

test('TOML: 지원하지 않는 문법은 조용히 넘기지 않고 알려준다', () => {
  assert.throws(() => parseToml('[[items]]'), (e: { code?: string }) => e.code === 'CONFIG_UNSUPPORTED_SYNTAX');
});

test('schema: default를 채우고 알 수 없는 항목을 거부한다', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['repo'],
    properties: { repo: { type: 'string' }, mode: { enum: ['summary', 'full'], default: 'summary' } },
  };
  const ok = validate(schema, { repo: 'my-service' });
  assert.ok(ok.valid);
  assert.equal((ok.value as any).mode, 'summary');

  const typo = validate(schema, { repo: 'x', moed: 'full' });
  assert.ok(!typo.valid);
  assert.match(typo.issues[0].message, /알 수 없는 항목/);
});

test('schema: 필수 항목 누락을 잡는다', () => {
  const r = validate({ type: 'object', required: ['repo'], properties: { repo: { type: 'string' } } }, {});
  assert.ok(!r.valid);
  assert.equal(r.issues[0].path, '$.repo');
});

test('schema: 중첩 배열 항목까지 검증한다', () => {
  const schema = {
    type: 'object',
    properties: { items: { type: 'array', items: { type: 'object', properties: { n: { type: 'integer' } } } } },
  };
  const r = validate(schema, { items: [{ n: 1 }, { n: 'two' }] });
  assert.ok(!r.valid);
  assert.equal(r.issues[0].path, '$.items[1].n');
});

// 회귀: 셀프체크가 00:01 KST에 잡은 버그.
// UTC 기준이면 KST 자정~09:00 사이 기록이 전날 파일로 가서 "오늘 로그"가 안 보인다.
test('감사 로그 날짜는 UTC가 아니라 로컬 기준이다', () => {
  const kstMidnight = new Date('2026-08-23T15:01:00Z'); // = 2026-08-24 00:01 KST
  const expected = `${kstMidnight.getFullYear()}-${String(kstMidnight.getMonth() + 1).padStart(2, '0')}-${String(kstMidnight.getDate()).padStart(2, '0')}`;
  assert.equal(localDate(kstMidnight), expected);
  assert.notEqual(localDate(kstMidnight), kstMidnight.toISOString().slice(0, 10) + '@utc');
});

test('타임스탬프에 오프셋이 붙어 모호하지 않다', () => {
  const iso = localISO(new Date('2026-08-23T15:01:00Z'));
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  // 같은 순간을 가리켜야 한다
  assert.equal(new Date(iso).getTime(), new Date('2026-08-23T15:01:00Z').getTime());
});

test('redact: 흔한 토큰 패턴을 마스킹한다', () => {
  assert.equal(redact('token=ghp_abcdefghijklmnopqrstuvwxyz012345'), 'token=***');
  assert.match(redact('password: "hunter2000"'), /\*\*\*/);
  assert.equal(redact('평범한 문장입니다'), '평범한 문장입니다');
});
