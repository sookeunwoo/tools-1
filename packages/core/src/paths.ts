/** devkit이 쓰는 모든 경로의 단일 출처. 테스트는 DEVKIT_HOME으로 격리한다. */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { localDate } from './time.ts';

export function devkitHome(): string {
  return process.env.DEVKIT_HOME ?? join(homedir(), '.devkit');
}

export function ensureHome(): string {
  const home = devkitHome();
  mkdirSync(join(home, 'runs'), { recursive: true });
  mkdirSync(join(home, 'profiles'), { recursive: true });
  return home;
}

export function dbPath(): string {
  return join(ensureHome(), 'devkit.db');
}

export function runsLogPath(when = new Date()): string {
  // 로컬 날짜 기준 로테이션 — 사람이 "오늘 로그"를 찾을 때 맞아야 한다 (time.ts 주석 참조)
  return join(ensureHome(), 'runs', `${localDate(when)}.jsonl`);
}

export function globalConfigPath(): string {
  return join(devkitHome(), 'config.toml');
}

export function profileConfigPath(name: string): string {
  return join(devkitHome(), 'profiles', `${name}.toml`);
}

/** devkit 저장소 루트 (packages/core/src → 3단계 위). */
export function repoRoot(): string {
  return resolve(fileURLToPath(import.meta.url), '../../../..');
}

export function toolsDir(): string {
  return process.env.DEVKIT_TOOLS_DIR ?? join(repoRoot(), 'tools');
}
