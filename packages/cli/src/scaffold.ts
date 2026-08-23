/**
 * `dk scaffold tool <name>` — 새 툴 뼈대 생성.
 *
 * 에이전트가 툴을 추가하는 표준 경로다. 계약을 처음부터 지킨 상태로 시작하게 해서
 * "manifest를 어떻게 쓰는지 몰라서 틀리는" 실패를 없앤다.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { toolsDir } from '#core/paths.ts';
import { DevkitError } from '#core/errors.ts';

export function scaffoldTool(name: string, summary?: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new DevkitError({
      code: 'SCAFFOLD_BAD_NAME',
      message: `툴 이름은 소문자/숫자/하이픈만 쓸 수 있습니다: ${name}`,
      retryable: false,
    });
  }
  const dir = join(toolsDir(), name);
  if (existsSync(dir)) {
    throw new DevkitError({
      code: 'SCAFFOLD_EXISTS',
      message: `이미 존재합니다: ${dir}`,
      hint: '다른 이름을 쓰거나 기존 툴을 수정하세요.',
      retryable: false,
    });
  }

  mkdirSync(join(dir, 'fixtures'), { recursive: true });

  const manifest = {
    name,
    version: '0.1.0',
    summary: summary ?? `TODO: ${name}이 하는 일 한 줄`,
    whenToUse: 'TODO: 에이전트가 이 툴을 언제 골라야 하는지 구체적으로. 20자 이상.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['repo'],
      properties: {
        repo: { type: 'string', description: '설정에 등록된 저장소 이름' },
        mode: { enum: ['summary', 'full'], default: 'summary' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array' } },
    },
    sideEffects: 'read',
    concurrency: { mode: 'safe', resourceKey: null },
    determinism: 'by-commit',
    timeoutSec: 60,
    requiresApproval: false,
    costHint: 'cheap',
  };
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  writeFileSync(
    join(dir, 'index.ts'),
    `/**
 * ${name} — TODO: 무엇을 하는 툴인지.
 *
 * 계약: manifest.json 참조. 지켜야 할 것은 tools/echo/index.ts 주석에 정리되어 있다.
 */

import type { ToolContext, ToolResult } from '#core/contract.ts';

type Input = { repo: string; mode: 'summary' | 'full' };

export async function run(input: Input, ctx: ToolContext): Promise<ToolResult> {
  ctx.log('시작', { repo: input.repo, mode: input.mode });

  // TODO: 구현. ctx.repoPath 에 저장소 절대경로가 들어 있다.
  const items: unknown[] = [];

  return {
    data: { items },
    // evidence가 비면 registry가 EVIDENCE_REQUIRED로 실패시킨다 (설계원칙 P3)
    evidence: [
      { kind: 'code', path: 'TODO', line: 1, sha: ctx.commitSha, excerpt: 'TODO' },
    ],
    // 정적 분석이면 추정 정확도를 정직하게 채운다 (설계원칙 P9)
    confidence: 1.0,
  };
}
`,
  );

  writeFileSync(
    join(dir, 'fixtures', 'basic.json'),
    JSON.stringify(
      { name: 'TODO: 기본 케이스', input: { repo: 'TODO' }, expect: { minEvidence: 1 } },
      null,
      2,
    ) + '\n',
  );

  writeFileSync(
    join(dir, 'README.md'),
    `# ${name}

${manifest.summary}

## 언제 쓰는가
${manifest.whenToUse}

## 사용
\`\`\`bash
dk run ${name} --input '{"repo":"my-service"}'
dk run ${name} --input '{"repo":"my-service"}' --explain   # 실행 없이 계획만
dk test ${name}
\`\`\`

## 정확도 한계
TODO: 이 툴이 못 잡는 것을 적는다. \`unresolved\`로 반환되는 경우를 명시.
`,
  );

  return dir;
}
