/**
 * context-pack 통합 테스트.
 *
 * 임시 git 저장소를 만들어 실제 실행 파이프라인을 통과시킨다.
 * 여기서 검증하는 건 "브리핑이 사실인가"다 — 이 툴은 새 세션의 유일한 입력이 되므로
 * 틀린 사실을 담으면 그 세션 전체가 잘못된 전제에서 출발한다.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;
let repo: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'devkit-cp-home-'));
  repo = mkdtempSync(join(tmpdir(), 'devkit-cp-repo-'));
  process.env.DEVKIT_HOME = home;

  // 기준 커밋: 소스 1개 + 그 테스트 + package.json
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(repo, 'test'), { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{"name":"fixture"}\n');
  writeFileSync(join(repo, 'src/Covered.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'test/Covered.test.ts'), 'test("a", () => {});\n');

  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'test']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);

  // 작업 중 상태: 기존 파일 수정 + 신규 소스(테스트 없음) + 신규 설정 파일
  writeFileSync(join(repo, 'src/Covered.ts'), 'export const a = 1;\nexport const b = 2;\n');
  writeFileSync(join(repo, 'src/Uncovered.ts'), 'export const c = 3;\nexport const d = 4;\nexport const e = 5;\n');
  writeFileSync(join(repo, 'config.json'), '{"x":1}\n');

  writeFileSync(
    join(home, 'config.toml'),
    `[repos.fixture]\npath = "${repo}"\nlang = ["typescript"]\n`,
  );
});

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function pack(input: Record<string, unknown>) {
  const { execute } = await import('#registry/execute.ts');
  return (await execute('context-pack', { repo: 'fixture', ...input }, { agentId: 'cp-test' })) as any;
}

test('수정 파일과 신규 파일을 모두 잡는다', async () => {
  const env = await pack({ task: '테스트 작업' });
  const paths = env.data.targetFiles.map((f: { path: string }) => f.path).sort();

  assert.deepEqual(paths, ['config.json', 'src/Covered.ts', 'src/Uncovered.ts']);
  // untracked 신규 파일은 git diff에 안 잡힌다 — 직접 세지 않으면 0으로 나온다(도그푸딩에서 발견한 버그)
  const uncovered = env.data.targetFiles.find((f: { path: string }) => f.path === 'src/Uncovered.ts');
  assert.equal(uncovered.added, 3, '신규 파일의 라인 수가 0으로 나오면 countLines가 깨진 것');
});

test('테스트 갭은 소스 파일에만 적용된다', async () => {
  const env = await pack({ task: '테스트 작업' });
  // config.json은 테스트 대상이 아니고, Covered.ts는 대응 테스트가 있다
  assert.deepEqual(env.data.testGaps, ['src/Uncovered.ts']);
});

test('브리핑에 5개 섹션이 모두 있다', async () => {
  const { data } = await pack({ task: '정산 배치 예외 처리', ticket: 'ABC-1234', dod: ['재시도 3회'] });
  for (const section of ['## 작업', '## 대상 파일', '## 확인된 사실', '## 완료 기준', '## 모르는 것']) {
    assert.ok(data.briefing.includes(section), `${section} 섹션이 없습니다`);
  }
  assert.ok(data.briefing.includes('ABC-1234'));
  assert.ok(data.briefing.includes('- [ ] 재시도 3회'), '사용자 지정 DoD가 누락되었습니다');
  assert.ok(data.briefing.includes('npm test'), '저장소 테스트 명령을 감지하지 못했습니다');
});

test('예산을 넘기면 잘라내고 좁히라고 알려준다', async () => {
  const env = await pack({ task: '큰 작업', budgetKb: 1 });
  if (env.data.withinBudget) return; // 픽스처가 작아 안 넘칠 수 있다

  assert.equal(env.truncated?.hasMore, true);
  assert.ok(env.unresolved.some((u: { reason: string }) => u.reason === 'budget-exceeded'));
  assert.ok(env.nextActions?.some((a: { tool: string }) => a.tool === 'context-pack'));
});

test('files를 지정하면 그것만 대상으로 삼는다', async () => {
  const env = await pack({ task: '범위 지정', files: ['src/Uncovered.ts'] });
  assert.deepEqual(env.data.targetFiles.map((f: { path: string }) => f.path), ['src/Uncovered.ts']);
});

test('모르는 것을 숨기지 않는다 (P9)', async () => {
  const env = await pack({ task: '테스트 작업' });
  const reasons = env.unresolved.map((u: { reason: string }) => u.reason);
  assert.ok(reasons.includes('call-graph-unknown'), '호출 관계 미확인 사실을 밝히지 않았습니다');
  assert.ok(reasons.includes('test-missing'));
  assert.ok(env.confidence < 1.0, '테스트 갭이 있는데 confidence가 1.0이면 정직하지 않다');
});

test('evidence 없이는 결과가 나오지 않는다 (P3)', async () => {
  const env = await pack({ task: '테스트 작업' });
  assert.ok(env.evidence.length > 0);
  assert.ok(env.evidence.some((e: { kind: string }) => e.kind === 'command'), 'git 명령 근거가 없습니다');
  assert.ok(env.evidence.some((e: { kind: string }) => e.kind === 'code'), '대상 파일 근거가 없습니다');
});

test('git 저장소가 아니면 명확히 실패한다', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'devkit-cp-plain-'));
  writeFileSync(join(home, 'config.toml'), `[repos.fixture]\npath = "${repo}"\n[repos.plain]\npath = "${plain}"\n`);
  try {
    const { execute } = await import('#registry/execute.ts');
    await assert.rejects(
      () => execute('context-pack', { repo: 'plain', task: 'x' }, { agentId: 'cp-test' }),
      (e: { code?: string }) => e.code === 'NOT_A_GIT_REPO',
    );
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});
