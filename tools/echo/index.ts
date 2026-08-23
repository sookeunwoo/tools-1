/**
 * echo — 툴 계약의 참조 구현.
 *
 * 새 툴을 만들 때 이 파일을 복사해서 시작한다. 지켜야 할 것:
 *   1. run(input, ctx)를 export 한다
 *   2. { data, evidence } 를 돌려준다 — evidence가 비면 registry가 실패시킨다 (P3)
 *   3. 오래 걸리는 작업은 ctx.signal.aborted를 확인한다 (타임아웃 협조)
 *   4. 파일은 300줄을 넘기지 않는다 (P8)
 */

import type { ToolContext, ToolResult } from '#core/contract.ts';

type Input = { message: string; repeat: number; delayMs: number };

export async function run(input: Input, ctx: ToolContext): Promise<ToolResult> {
  if (input.delayMs > 0) await sleep(input.delayMs, ctx.signal);

  const echoed = Array.from({ length: input.repeat }, (_, i) =>
    input.repeat === 1 ? input.message : `${i + 1}: ${input.message}`,
  );

  ctx.log('echoed', { count: echoed.length });

  return {
    data: { echoed, count: echoed.length },
    evidence: [
      { kind: 'command', command: `echo(${JSON.stringify(input.message)})`, exitCode: 0, excerpt: echoed[0] },
    ],
    confidence: 1.0,
  };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('취소되었습니다'));
    }, { once: true });
  });
}
