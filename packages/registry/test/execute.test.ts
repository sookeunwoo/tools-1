/**
 * 실행 파이프라인 통합 테스트.
 *
 * 여기서 검증하는 건 devkit의 설계 주장 그 자체다:
 *   - evidence 없는 결과는 반환되지 않는다 (P3)
 *   - 계약 위반은 실행 전/후 양쪽에서 걸린다
 *   - 실패도 ledger에 남는다 (dk stats가 정직해야 개선점이 보인다)
 *   - 캐시가 결정적 툴에만 적용된다 (P6)
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from '#core/paths.ts';

let home: string;
let tools: string;

const CORE = join(repoRoot(), 'packages/core/src');

/** 임시 툴 디렉토리에 툴 하나를 만든다. */
function makeTool(name: string, manifest: Record<string, unknown>, body: string): void {
  const dir = join(tools, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify(
      {
        name,
        version: '1.0.0',
        summary: `${name} 테스트 툴`,
        whenToUse: '테스트에서만 사용하는 툴입니다. 실제 작업에는 쓰지 않습니다.',
        inputSchema: { type: 'object', additionalProperties: false, properties: { n: { type: 'integer', default: 1 } } },
        outputSchema: { type: 'object', required: ['value'], properties: { value: { type: 'integer' } } },
        sideEffects: 'read',
        concurrency: { mode: 'safe', resourceKey: null },
        determinism: 'pure',
        timeoutSec: 5,
        requiresApproval: false,
        ...manifest,
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'index.ts'), `import type { ToolContext, ToolResult } from '${CORE}/contract.ts';\n${body}`);
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'devkit-exec-'));
  tools = join(home, 'tools');
  mkdirSync(tools, { recursive: true });
  process.env.DEVKIT_HOME = home;
  process.env.DEVKIT_PLUGINS_DIR = tools;

  makeTool('good', {}, `
    export async function run(input: any): Promise<ToolResult> {
      return { data: { value: input.n * 2 },
               evidence: [{ kind: 'command', command: 'double', exitCode: 0 }], confidence: 0.9 };
    }`);

  makeTool('no-evidence', {}, `
    export async function run(input: any): Promise<ToolResult> {
      return { data: { value: 1 } };   // evidence 없음 — 거부되어야 한다
    }`);

  makeTool('bad-output', {}, `
    export async function run(): Promise<ToolResult> {
      return { data: { value: 'not-an-integer' },
               evidence: [{ kind: 'command', command: 'x', exitCode: 0 }] };
    }`);

  makeTool('meta', { evidenceOptional: true }, `
    export async function run(): Promise<ToolResult> {
      return { data: { value: 42 } };   // evidenceOptional이면 허용
    }`);

  makeTool('slow', { timeoutSec: 1 }, `
    export async function run(_i: any, ctx: ToolContext): Promise<ToolResult> {
      await new Promise(r => setTimeout(r, 3000));
      return { data: { value: 1 }, evidence: [{ kind: 'command', command: 'x', exitCode: 0 }] };
    }`);
});

after(() => rmSync(home, { recursive: true, force: true }));

let execute: typeof import('#registry/execute.ts').execute;
let listRuns: typeof import('#core/ledger.ts').listRuns;

beforeEach(async () => {
  ({ execute } = await import('#registry/execute.ts'));
  ({ listRuns } = await import('#core/ledger.ts'));
});

test('정상 툴은 봉투에 담겨 반환된다', async () => {
  const env = (await execute('good', { n: 21 }, { agentId: 'T1', refresh: true })) as any;
  assert.equal(env.ok, true);
  assert.equal(env.data.value, 42);
  assert.equal(env.confidence, 0.9);
  assert.equal(env.evidence.length, 1);
  assert.equal(typeof env.timings.totalMs, 'number');
});

test('evidence가 없으면 결과를 반환하지 않는다 (P3)', async () => {
  await assert.rejects(
    () => execute('no-evidence', {}, { agentId: 'T1' }),
    (e: { code?: string; source?: { file: string } }) => {
      assert.equal(e.code, 'EVIDENCE_REQUIRED');
      // 에이전트가 바로 찾아갈 수 있게 위치가 붙어야 한다 (제약 2)
      assert.match(e.source!.file, /plugins\/no-evidence\/index\.ts/);
      return true;
    },
  );
});

test('evidenceOptional 메타 툴은 예외로 허용된다', async () => {
  const env = (await execute('meta', {}, { agentId: 'T1', refresh: true })) as any;
  assert.equal(env.ok, true);
});

test('출력이 계약과 다르면 거부한다', async () => {
  await assert.rejects(
    () => execute('bad-output', {}, { agentId: 'T1' }),
    (e: { code?: string }) => e.code === 'OUTPUT_CONTRACT_VIOLATION',
  );
});

test('입력이 계약과 다르면 실행 전에 거부한다', async () => {
  await assert.rejects(
    () => execute('good', { typo: 1 }, { agentId: 'T1' }),
    (e: { code?: string; message?: string }) => {
      assert.equal(e.code, 'INPUT_INVALID');
      assert.match(e.message!, /알 수 없는 항목/);
      return true;
    },
  );
});

test('타임아웃이 동작한다', async () => {
  await assert.rejects(
    () => execute('slow', {}, { agentId: 'T1' }),
    (e: { code?: string }) => e.code === 'TOOL_TIMEOUT',
  );
});

test('실패도 ledger에 남는다 — dk stats가 정직해야 한다', async () => {
  await execute('good', { n: 1 }, { agentId: 'T-ledger', refresh: true });
  await execute('good', { typo: 1 }, { agentId: 'T-ledger' }).catch(() => {});
  await execute('missing-tool', {}, { agentId: 'T-ledger' }).catch(() => {});

  const rows = listRuns({ limit: 100 });
  const codes = rows.map((r) => r.error_code);
  assert.ok(codes.includes('INPUT_INVALID'), '입력 계약 위반이 기록되지 않았습니다');
  assert.ok(codes.includes('TOOL_NOT_FOUND'), '없는 툴 호출이 기록되지 않았습니다');
});

test('결정적 툴은 캐시된다 (P6)', async () => {
  const first = (await execute('good', { n: 7 }, { agentId: 'T-cache', refresh: true })) as any;
  const second = (await execute('good', { n: 7 }, { agentId: 'T-cache' })) as any;
  assert.equal(first.timings.cacheHit, false);
  assert.equal(second.timings.cacheHit, true);
  assert.deepEqual(second.data, first.data);
});

test('--explain은 실행하지 않고 계획만 돌려준다', async () => {
  const plan = (await execute('good', { n: 3 }, { agentId: 'T1', explain: true })) as any;
  assert.equal(plan.tool, 'good');
  assert.deepEqual(plan.resolvedInput, { n: 3 });
  assert.equal(plan.policy.effect, 'allow');
  assert.equal(plan.data, undefined);
});
