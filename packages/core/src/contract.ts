/**
 * 툴 계약 (plan.md §4.3) — devkit에서 가장 중요한 추상화.
 *
 * 모든 툴은 manifest.json(계약) + index.ts(구현) 한 쌍이다.
 * 구현은 `data`/`evidence`만 돌려주고, 봉투(runId/timings/ok)는 registry가 씌운다.
 */

import type { Schema } from './schema.ts';
import type { Config } from './config.ts';

export type SideEffect = 'read' | 'write' | 'external';
export type Determinism = 'pure' | 'by-commit' | 'nondeterministic';

export type Manifest = {
  name: string;
  version: string;
  summary: string;
  /** LLM이 읽는 필드 — 언제 이 툴을 써야 하는지. */
  whenToUse: string;
  inputSchema: Schema;
  outputSchema: Schema;
  sideEffects: SideEffect;
  concurrency: { mode: 'safe' | 'exclusive'; resourceKey: string | null };
  determinism: Determinism;
  timeoutSec: number;
  requiresApproval: boolean;
  costHint?: string;
  /** evidence 강제 예외. 메타 툴(devkit-observe 등)만 true. */
  evidenceOptional?: boolean;
};

/** 근거 (설계원칙 P3). 이게 비면 registry가 실행을 실패 처리한다. */
export type Evidence =
  | { kind: 'code'; path: string; line?: number; sha?: string; excerpt?: string }
  | { kind: 'query'; source: string; text: string; rows?: number }
  | { kind: 'command'; command: string; exitCode: number; excerpt?: string }
  | { kind: 'ledger'; runId: string; note?: string }
  | { kind: 'doc'; url: string; note?: string };

/** 모르는 것을 모른다고 말하는 자리 (설계원칙 P9). */
export type Unresolved = { reason: string; at: string; hint?: string };

/** 에이전트가 다음에 뭘 할지 스스로 판단하게 돕는다. */
export type NextAction = { tool: string; input: Record<string, unknown>; why: string };

export type ToolResult = {
  data: unknown;
  evidence?: Evidence[];
  unresolved?: Unresolved[];
  nextActions?: NextAction[];
  /** 0~1. 정적 분석 툴은 반드시 채운다. */
  confidence?: number;
  truncated?: { hasMore: boolean; cursor?: string };
};

export type ToolContext = {
  runId: string;
  traceId: string;
  agentId: string;
  config: Config;
  /** 대상 저장소 절대경로 (입력에 repo가 있을 때만). */
  repoPath?: string;
  commitSha?: string;
  /** 배타 자원 획득. registry가 종료 시 자동 해제한다. */
  lease: (resourceKey: string, opts?: { waitMs?: number; ttlMs?: number }) => Promise<void>;
  log: (message: string, fields?: Record<string, unknown>) => void;
  /** 취소/타임아웃 신호. 긴 작업은 이걸 확인해야 한다. */
  signal: AbortSignal;
};

export type ToolModule = {
  run: (input: any, ctx: ToolContext) => Promise<ToolResult> | ToolResult;
};

export type Envelope = {
  ok: boolean;
  toolVersion: string;
  runId: string;
  confidence?: number;
  data?: unknown;
  evidence?: Evidence[];
  unresolved?: Unresolved[];
  nextActions?: NextAction[];
  truncated?: { hasMore: boolean; cursor?: string };
  timings: { totalMs: number; cacheHit: boolean };
  error?: unknown;
};
