/**
 * 구조화 에러 (설계원칙 P5).
 *
 * 모든 실패는 `code`/`hint`/`fixCommand`/`source`를 들고 다닌다.
 * `source`가 핵심이다 — 에이전트가 스택트레이스를 뒤지는 대신
 * 출력에 적힌 파일:라인으로 바로 찾아가 고칠 수 있게 한다 (제약 2).
 */

export type ErrorSource = { file: string; line: number };

export type ErrorPayload = {
  code: string;
  message: string;
  hint?: string;
  retryable: boolean;
  fixCommand?: string;
  source?: ErrorSource;
  details?: unknown;
};

export class DevkitError extends Error {
  code: string;
  hint?: string;
  retryable: boolean;
  fixCommand?: string;
  source?: ErrorSource;
  details?: unknown;

  constructor(payload: ErrorPayload) {
    super(payload.message);
    this.name = 'DevkitError';
    this.code = payload.code;
    this.hint = payload.hint;
    this.retryable = payload.retryable ?? false;
    this.fixCommand = payload.fixCommand;
    this.source = payload.source ?? callerSource();
    this.details = payload.details;
  }

  toJSON(): ErrorPayload {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      retryable: this.retryable,
      fixCommand: this.fixCommand,
      source: this.source,
      details: this.details,
    };
  }
}

/** 알 수 없는 throw 값을 항상 DevkitError로 정규화한다. */
export function toDevkitError(err: unknown): DevkitError {
  if (err instanceof DevkitError) return err;
  const e = err as { message?: string; stack?: string; code?: string };
  return new DevkitError({
    code: e?.code ?? 'UNEXPECTED',
    message: e?.message ?? String(err),
    retryable: false,
    hint: '예상하지 못한 예외입니다. source 위치의 코드를 확인하세요.',
    source: sourceFromStack(e?.stack),
    details: e?.stack,
  });
}

/** DevkitError 생성 지점의 호출자 위치를 추출한다. */
function callerSource(): ErrorSource | undefined {
  const stack = new Error().stack;
  // 0: Error, 1: callerSource, 2: DevkitError ctor, 3: 실제 throw 지점
  return sourceFromStack(stack, 3);
}

export function sourceFromStack(stack?: string, skip = 1): ErrorSource | undefined {
  if (!stack) return undefined;
  const lines = stack.split('\n').slice(1);
  for (const line of lines.slice(skip - 1)) {
    const m = line.match(/\(?(\/[^()]+?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    if (m[1].includes('node:internal')) continue;
    return { file: relativize(m[1]), line: Number(m[2]) };
  }
  return undefined;
}

/** devkit 저장소 기준 상대경로로 줄여 에이전트가 바로 열 수 있게 한다. */
function relativize(file: string): string {
  const marker = '/devkit/';
  const i = file.lastIndexOf(marker);
  return i === -1 ? file : file.slice(i + marker.length);
}
