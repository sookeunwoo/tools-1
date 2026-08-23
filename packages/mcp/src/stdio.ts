/**
 * MCP stdio 어댑터 (설계원칙 P1: 얇게 유지한다).
 *
 * 여기에는 로직이 없다. JSON-RPC 프레이밍 ↔ registry.execute() 변환만 한다.
 * MCP 스펙이 바뀌어도 이 파일만 고치면 되게 하는 게 목적이다.
 *
 * SDK를 쓰지 않고 직접 구현한 이유: stdio MCP는 JSON-RPC 2.0 위에
 * initialize/tools/list/tools/call 세 개뿐이라 200줄이면 되고,
 * 의존성 0을 유지하는 편이 에이전트의 디버깅에 유리하다.
 */

import { createInterface } from 'node:readline';
import { toDevkitError } from '#core/errors.ts';
import { listTools } from '#registry/registry.ts';
import { execute } from '#registry/execute.ts';
import type { Envelope } from '#core/contract.ts';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'devkit', version: '0.1.0' };

type Request = { jsonrpc: '2.0'; id?: string | number; method: string; params?: any };

export async function serve(): Promise<void> {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

  // await 하지 않고 각 요청을 독립적으로 처리한다 —
  // 여러 툴 호출이 동시에 진행될 수 있어야 한다 (요구사항 3).
  rl.on('line', (line) => {
    if (!line.trim()) return;
    void handleLine(line);
  });

  await new Promise<void>((resolve) => rl.on('close', resolve));
}

async function handleLine(line: string): Promise<void> {
  let req: Request;
  try {
    req = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }

  // 알림(notification)에는 응답하지 않는다.
  if (req.id === undefined) return;

  try {
    send({ jsonrpc: '2.0', id: req.id, result: await dispatch(req) });
  } catch (err) {
    const e = toDevkitError(err);
    send({
      jsonrpc: '2.0',
      id: req.id,
      error: { code: -32603, message: e.message, data: e.toJSON() },
    });
  }
}

async function dispatch(req: Request): Promise<unknown> {
  switch (req.method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          'devkit 툴은 모두 evidence(근거)를 함께 반환합니다. 문서나 코드를 작성할 때 그 evidence를 인용하세요. ' +
          'confidence가 낮거나 unresolved 항목이 있으면 단정하지 말고 직접 확인하세요. ' +
          '작업 전에 devkit-observe로 다른 에이전트가 점유한 자원을 확인하면 대기를 피할 수 있습니다.',
      };

    case 'ping':
      return {};

    case 'tools/list':
      return {
        tools: listTools().map(({ manifest }) => ({
          name: manifest.name,
          description: `${manifest.summary}\n\n언제 쓰는가: ${manifest.whenToUse}`,
          inputSchema: manifest.inputSchema,
          annotations: {
            readOnlyHint: manifest.sideEffects === 'read',
            openWorldHint: manifest.sideEffects === 'external',
          },
        })),
      };

    case 'tools/call':
      return await callTool(req.params?.name, req.params?.arguments ?? {}, req.params?._meta);

    default:
      throw toDevkitError({ code: 'MCP_METHOD_NOT_FOUND', message: `지원하지 않는 메서드: ${req.method}` });
  }
}

async function callTool(name: string, args: unknown, meta?: Record<string, unknown>): Promise<unknown> {
  try {
    const envelope = (await execute(name, args, {
      // 에이전트가 _meta로 신원을 주면 ledger에 그대로 남는다 → 누가 뭘 했는지 추적 가능
      agentId: typeof meta?.agentId === 'string' ? meta.agentId : process.env.DEVKIT_AGENT_ID ?? 'mcp',
      traceId: typeof meta?.traceId === 'string' ? meta.traceId : undefined,
      idempotencyKey: typeof meta?.idempotencyKey === 'string' ? meta.idempotencyKey : undefined,
      // MCP 호출은 다른 에이전트를 기다려줄 여유가 있다. CLI 기본값(0)보다 길게.
      leaseWaitMs: 30_000,
    })) as Envelope;

    return {
      content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
      structuredContent: envelope,
      isError: false,
    };
  } catch (err) {
    const e = toDevkitError(err);
    // 프로토콜 에러가 아니라 툴 에러로 돌려준다 — 에이전트가 hint/fixCommand를 보고
    // 스스로 복구하거나 툴을 고칠 수 있어야 한다 (제약 2).
    return {
      content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.toJSON() }, null, 2) }],
      structuredContent: { ok: false, error: e.toJSON() },
      isError: true,
    };
  }
}

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

if (import.meta.filename === process.argv[1]) {
  serve().catch((err) => {
    process.stderr.write(`MCP 서버 시작 실패: ${(err as Error).message}\n`);
    process.exit(1);
  });
}
