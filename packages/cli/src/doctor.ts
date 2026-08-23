/**
 * `dk doctor` — 환경 진단.
 *
 * 모든 문제에 fixCommand를 붙인다. 에이전트가 진단 결과만 보고
 * 스스로 복구할 수 있어야 한다 (제약 2).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { devkitHome, ensureHome, globalConfigPath, toolsDir, dbPath } from '#core/paths.ts';
import { loadConfig, listRepos, resolveRepo } from '#core/config.ts';
import { db } from '#core/db.ts';
import { sweep, activeLeases } from '#core/lease.ts';
import { listTools } from '#registry/registry.ts';

export type Check = { name: string; ok: boolean; detail: string; fixCommand?: string };

export function diagnose(): Check[] {
  const checks: Check[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'Node 버전',
    ok: major >= 24,
    detail: `${process.version} (필요: >= 24 — node:sqlite 내장 및 TS 직접 실행)`,
    fixCommand: major >= 24 ? undefined : 'nvm install 24 && nvm use 24',
  });

  checks.push(check('DEVKIT_HOME 쓰기 가능', () => {
    ensureHome(); // 없으면 만든다 — 첫 실행에서 없는 건 오류가 아니다
    accessSync(devkitHome(), constants.W_OK);
    return devkitHome();
  }, `mkdir -p ${devkitHome()}`));

  checks.push(check('SQLite 열기', () => {
    db().prepare('SELECT 1').get();
    return dbPath();
  }, `rm ${dbPath()}  # 손상 시 재생성 (JSONL이 진실 원천이므로 복구 가능)`));

  const configExists = existsSync(globalConfigPath());
  checks.push({
    name: '전역 설정',
    ok: true, // 없어도 동작한다. 다만 저장소 등록이 안 돼 있을 뿐
    detail: configExists ? globalConfigPath() : `${globalConfigPath()} 없음 (기본값으로 동작)`,
    fixCommand: configExists ? undefined : 'dk init',
  });

  checks.push(check('툴 레지스트리', () => {
    const tools = listTools();
    if (tools.length === 0) throw new Error(`${toolsDir()} 에 툴이 없습니다`);
    return `${tools.length}개 — ${tools.map((t) => t.manifest.name).join(', ')}`;
  }, 'dk scaffold tool <name>'));

  const config = loadConfig();
  const repos = listRepos(config);
  if (repos.length === 0) {
    checks.push({
      name: '등록된 저장소',
      ok: false,
      detail: '없음 — 코드 분석 툴을 쓰려면 저장소를 등록해야 합니다',
      fixCommand: 'dk init',
    });
  } else {
    for (const name of repos) {
      checks.push(check(`저장소 '${name}'`, () => resolveRepo(config, name).path));
    }
  }

  checks.push(check('git', () => version('git', ['--version'])));
  checks.push(check('security (Keychain)', () => {
    execFileSync('security', ['-h'], { stdio: 'ignore' });
    return '사용 가능';
  }, 'macOS 기본 도구입니다. PATH를 확인하세요.'));

  // mysql CLI는 M5 schema-inspect에서만 필요하다. 없어도 M0~M4는 정상 동작한다.
  const hasMysql = tryVersion('mysql', ['--version']);
  checks.push({
    name: 'mysql CLI (M5에서 필요)',
    ok: true,
    detail: hasMysql ?? '없음 — schema-inspect(M5) 전까지는 불필요. docker 경유 예정',
  });

  const swept = sweep();
  const active = activeLeases();
  checks.push({
    name: '임대 상태',
    ok: true,
    detail: `유효 ${active.length}개, 만료 정리 ${swept}개${active.length ? ` — ${active.map((l) => `${l.resourceKey}(${l.ownerAgent})`).join(', ')}` : ''}`,
  });

  return checks;
}

function check(name: string, fn: () => string, fixCommand?: string): Check {
  try {
    return { name, ok: true, detail: fn() };
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message, fixCommand };
  }
}

function version(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0];
}

function tryVersion(cmd: string, args: string[]): string | null {
  try {
    return version(cmd, args);
  } catch {
    return null;
  }
}
