/**
 * repo-map — 코드 인덱스 생성 (plan.md §12, 기둥 A).
 *
 * 존재 이유: 에이전트가 코드베이스를 매번 Bash/Read로 훑는 걸 없앤다.
 * 한 번 스캔해 커밋 SHA 기준으로 캐시하고, 이후 조회는 인덱스에서만 한다 (P11).
 *
 * 정확도: 어휘 스캐너 기반이라 타입 추론이 없다. 못 읽은 것은 gaps로 남기고
 * confidence를 그만큼 낮춘다 (P9). 정확도가 목표에 못 미치면 ADR-004로 승급한다.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { Evidence, NextAction, ToolContext, ToolResult, Unresolved } from '#core/contract.ts';
import { DevkitError } from '#core/errors.ts';
import { scanJvm } from '#lang/jvm.ts';
import { scanTypeScript } from '#lang/typescript.ts';
import { writeIndex, indexPath } from '#lang/store.ts';
import type { FileSymbols, Lang, ScanGap } from '#lang/types.ts';

type Input = { repo: string; include?: string[]; maxFiles: number; listEndpoints: boolean };

const LANG_BY_EXT: Record<string, Lang> = {
  '.kt': 'kotlin', '.kts': 'kotlin', '.java': 'java',
  '.ts': 'typescript', '.tsx': 'typescript', '.js': 'typescript', '.jsx': 'typescript',
};

export async function run(input: Input, ctx: ToolContext): Promise<ToolResult> {
  const cwd = ctx.repoPath;
  if (!cwd) {
    throw new DevkitError({
      code: 'REPO_PATH_MISSING',
      message: `'${input.repo}'의 경로를 해석하지 못했습니다`,
      hint: '~/.devkit/config.toml 의 [repos.<name>] path 를 확인하세요.',
      retryable: false,
    });
  }

  const evidence: Evidence[] = [];
  const unresolved: Unresolved[] = [];

  // git ls-files: .gitignore를 존중하고 빠르다. 저장소가 아니면 바로 실패시킨다.
  let listed: string[];
  try {
    listed = execFileSync('git', ['ls-files'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n').filter(Boolean);
  } catch {
    throw new DevkitError({
      code: 'NOT_A_GIT_REPO',
      message: `${cwd} 는 git 저장소가 아닙니다`,
      hint: 'repo-map은 git ls-files로 대상 파일을 고릅니다.',
      retryable: false,
    });
  }
  evidence.push({ kind: 'command', command: 'git ls-files', exitCode: 0, excerpt: `${listed.length}개 추적 파일` });

  const candidates = listed
    .filter((p) => LANG_BY_EXT[extname(p)])
    .filter((p) => !input.include?.length || input.include.some((pre) => p.startsWith(pre)))
    .filter((p) => !/(^|\/)(node_modules|build|out|dist|\.gradle)\//.test(p));

  const targets = candidates.slice(0, input.maxFiles);
  if (candidates.length > targets.length) {
    unresolved.push({
      reason: 'max-files-exceeded',
      at: `${candidates.length}개 중 ${targets.length}개만 인덱싱`,
      hint: 'include로 모듈을 좁히거나 maxFiles를 올리세요. 인덱스가 불완전하면 trace-flow도 불완전합니다.',
    });
  }

  // ── 스캔 ────────────────────────────────────────────────────
  const files: FileSymbols[] = [];
  const gaps: ScanGap[] = [];
  const byLang: Record<string, number> = {};
  let readFailures = 0;

  for (const rel of targets) {
    if (ctx.signal.aborted) break;
    const lang = LANG_BY_EXT[extname(rel)];
    let src: string;
    try {
      src = readFileSync(join(cwd, rel), 'utf8');
    } catch {
      readFailures++;
      gaps.push({ path: rel, line: 1, reason: 'read-failed' });
      continue;
    }
    const symbols = lang === 'typescript' ? scanTypeScript(rel, src, gaps) : scanJvm(rel, src, lang, gaps);
    files.push(symbols);
    byLang[lang] = (byLang[lang] ?? 0) + 1;
  }

  // ── 저장 ────────────────────────────────────────────────────
  const commitSha = ctx.commitSha ?? null;
  const meta = {
    commitSha: commitSha ?? 'dirty',
    indexedAt: new Date().toISOString(),
    toolVersion: '0.1.0',
    fileCount: files.length,
  };
  writeIndex(input.repo, files, gaps, meta);

  const counts = {
    files: files.length,
    types: files.reduce((n, f) => n + f.types.length, 0),
    methods: files.reduce((n, f) => n + f.types.reduce((k, t) => k + t.methods.length, 0), 0),
    endpoints: files.reduce((n, f) => n + f.endpoints.length, 0),
    calls: files.reduce((n, f) => n + f.types.reduce((k, t) => k + t.methods.reduce((j, m) => j + m.calls.length, 0), 0), 0),
    gaps: gaps.length,
  };

  evidence.push({ kind: 'command', command: `scan ${files.length} files`, exitCode: 0,
                  excerpt: `types=${counts.types} methods=${counts.methods} endpoints=${counts.endpoints}` });
  for (const f of files.filter((x) => x.endpoints.length > 0).slice(0, 5)) {
    evidence.push({ kind: 'code', path: f.path, line: f.endpoints[0].line, sha: commitSha ?? undefined,
                    excerpt: f.endpoints[0].key });
  }

  // ── 못 읽은 것 (숨기지 않는다) ───────────────────────────────
  const byReason = new Map<string, number>();
  for (const g of gaps) byReason.set(g.reason, (byReason.get(g.reason) ?? 0) + 1);
  for (const [reason, count] of [...byReason.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    unresolved.push({ reason, at: `${count}건`, hint: gapHint(reason) });
  }
  if (commitSha === null) {
    unresolved.push({
      reason: 'dirty-working-tree',
      at: input.repo,
      hint: '커밋되지 않은 변경이 있어 인덱스가 캐시되지 않습니다. 결과는 지금 워킹트리 기준입니다.',
    });
  }

  ctx.log('인덱싱 완료', counts);

  const gapRatio = counts.types > 0 ? gaps.length / (counts.types + gaps.length) : 0;
  const nextActions: NextAction[] = counts.endpoints > 0
    ? [{ tool: 'trace-flow',
         input: { repo: input.repo, entry: files.flatMap((f) => f.endpoints)[0]?.key },
         why: '인덱스가 준비됐습니다. 엔드포인트에서 다운스트림 흐름을 따라가세요' }]
    : [];

  return {
    data: {
      commitSha,
      indexPath: indexPath(input.repo),
      counts,
      languages: byLang,
      endpoints: input.listEndpoints ? files.flatMap((f) => f.endpoints.map((e) => ({ ...e, path: f.path }))) : undefined,
      topGaps: [...byReason.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    },
    evidence,
    unresolved: unresolved.length ? unresolved : undefined,
    nextActions: nextActions.length ? nextActions : undefined,
    // 못 읽은 타입 비율만큼 신뢰도를 깎는다. 읽기 실패도 반영.
    confidence: round(Math.max(0.3, 1 - gapRatio - readFailures / Math.max(1, targets.length))),
  };
}

function gapHint(reason: string): string {
  switch (reason) {
    case 'type-body-absent': return '본문 없는 선언입니다(마커 인터페이스·@Entity 등). 타입 자체는 인덱싱했지만 멤버는 없습니다.';
    case 'type-body-not-found': return '타입 본문의 중괄호 짝을 못 찾았습니다. 이 타입의 멤버는 인덱스에 없습니다.';
    case 'no-type-parsed': return '타입 선언이 있는데 하나도 읽지 못했습니다. 문법이 스캐너 범위 밖일 수 있습니다.';
    case 'read-failed': return '파일을 읽지 못했습니다(바이너리·인코딩·권한).';
    default: return '스캐너가 해석하지 못한 구간입니다. 해당 파일은 직접 확인하세요.';
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
