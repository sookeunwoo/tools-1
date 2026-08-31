/**
 * 골든 픽스처 + 계약 테스트 러너 (`dk test`).
 *
 * 제약 2("에이전트가 툴 버그를 고칠 수 있다")의 안전망이다.
 * 에이전트가 툴을 수정한 뒤 5초 안에 회귀를 확인할 수 있어야 한다.
 *
 * 두 종류를 돌린다:
 *   1. 골든 픽스처 — plugins/<name>/fixtures/*.json 의 입력/기대출력 쌍
 *   2. 계약 테스트 — manifest에서 자동 생성 (스키마 위반 입력이 거부되는지 등)
 */

import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validate } from '#core/schema.ts';
import { toDevkitError } from '#core/errors.ts';
import { listTools, getTool } from '#registry/registry.ts';
import { execute } from '#registry/execute.ts';
import type { Envelope } from '#core/contract.ts';

export type CaseResult = { tool: string; name: string; kind: 'golden' | 'contract'; ok: boolean; detail?: string };

type Fixture = {
  name: string;
  input: unknown;
  expect?: {
    data?: unknown;
    minEvidence?: number;
    confidence?: number;
    minConfidence?: number;
  };
  expectError?: string;
};

export async function runTests(toolName?: string): Promise<CaseResult[]> {
  const entries = toolName ? [getTool(toolName)] : listTools();
  const results: CaseResult[] = [];

  for (const entry of entries) {
    results.push(...contractCases(entry.manifest.name));
    for (const fixture of loadFixtures(entry.dir)) {
      results.push(await runFixture(entry.manifest.name, fixture));
    }
  }
  return results;
}

function loadFixtures(dir: string): Fixture[] {
  const fixturesDir = join(dir, 'fixtures');
  if (!existsSync(fixturesDir)) return [];
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const path = join(fixturesDir, f);
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
      return { ...parsed, name: parsed.name ?? f };
    });
}

async function runFixture(tool: string, fixture: Fixture): Promise<CaseResult> {
  const base = { tool, name: fixture.name, kind: 'golden' as const };
  let envelope: Envelope;
  try {
    // refresh: 캐시가 회귀를 가려버리면 테스트가 의미 없다
    envelope = (await execute(tool, fixture.input, { agentId: 'dk-test', refresh: true })) as Envelope;
  } catch (err) {
    const e = toDevkitError(err);
    if (fixture.expectError) {
      return e.code === fixture.expectError
        ? { ...base, ok: true }
        : { ...base, ok: false, detail: `기대 에러 ${fixture.expectError}, 실제 ${e.code}: ${e.message}` };
    }
    return { ...base, ok: false, detail: `${e.code}: ${e.message}${e.source ? ` (${e.source.file}:${e.source.line})` : ''}` };
  }

  if (fixture.expectError) {
    return { ...base, ok: false, detail: `에러 ${fixture.expectError}를 기대했지만 성공했습니다` };
  }

  const expect = fixture.expect ?? {};
  if (expect.data !== undefined) {
    const diff = subsetDiff(expect.data, envelope.data);
    if (diff) return { ...base, ok: false, detail: `data 불일치 — ${diff}` };
  }
  if (expect.minEvidence !== undefined && (envelope.evidence?.length ?? 0) < expect.minEvidence) {
    return { ...base, ok: false, detail: `evidence ${expect.minEvidence}개 이상 기대, 실제 ${envelope.evidence?.length ?? 0}개` };
  }
  if (expect.confidence !== undefined && envelope.confidence !== expect.confidence) {
    return { ...base, ok: false, detail: `confidence ${expect.confidence} 기대, 실제 ${envelope.confidence}` };
  }
  if (expect.minConfidence !== undefined && (envelope.confidence ?? 0) < expect.minConfidence) {
    return { ...base, ok: false, detail: `confidence ${expect.minConfidence} 이상 기대, 실제 ${envelope.confidence}` };
  }
  return { ...base, ok: true };
}

/** manifest만으로 만들 수 있는 검증. 툴 구현이 바뀌어도 계약은 지켜져야 한다. */
function contractCases(toolName: string): CaseResult[] {
  const { manifest } = getTool(toolName);
  const out: CaseResult[] = [];
  const base = { tool: toolName, kind: 'contract' as const };

  const requiredExists = (manifest.inputSchema.required ?? []).every(
    (k: string) => manifest.inputSchema.properties?.[k] !== undefined,
  );
  out.push({
    ...base,
    name: 'required 항목이 properties에 정의되어 있다',
    ok: requiredExists,
    detail: requiredExists ? undefined : 'required에 있는데 properties에 없는 키가 있습니다',
  });

  const described = Object.keys(manifest.inputSchema.properties ?? {}).length > 0 || manifest.inputSchema.type !== 'object';
  out.push({ ...base, name: 'inputSchema에 properties가 있다', ok: described });

  // 스키마가 실제로 거부 기능을 하는지 (additionalProperties: false 여부)
  const strict = manifest.inputSchema.additionalProperties === false;
  out.push({
    ...base,
    name: 'inputSchema가 알 수 없는 항목을 거부한다',
    ok: strict,
    detail: strict ? undefined : 'additionalProperties: false 를 넣으면 에이전트의 오타를 조기에 잡습니다',
  });

  const outputOk = validate({ type: 'object' }, manifest.outputSchema).valid;
  out.push({ ...base, name: 'outputSchema가 객체 스키마다', ok: outputOk });

  const whenToUseLength = manifest.whenToUse.length >= 20;
  out.push({
    ...base,
    name: 'whenToUse가 LLM이 판단할 만큼 구체적이다',
    ok: whenToUseLength,
    detail: whenToUseLength ? undefined : 'whenToUse가 너무 짧습니다(20자 미만). 에이전트가 툴 선택을 못 합니다',
  });

  return out;
}

/** 기대값이 실제값의 부분집합인지 확인. 실제값에 필드가 더 있어도 통과. */
function subsetDiff(expected: unknown, actual: unknown, path = 'data'): string | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: 배열이 아닙니다`;
    if (expected.length !== actual.length) return `${path}: 길이 ${expected.length} 기대, 실제 ${actual.length}`;
    for (let i = 0; i < expected.length; i++) {
      const d = subsetDiff(expected[i], actual[i], `${path}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return `${path}: 객체가 아닙니다`;
    for (const [k, v] of Object.entries(expected)) {
      const d = subsetDiff(v, (actual as Record<string, unknown>)[k], `${path}.${k}`);
      if (d) return d;
    }
    return null;
  }
  return expected === actual ? null : `${path}: ${JSON.stringify(expected)} 기대, 실제 ${JSON.stringify(actual)}`;
}
