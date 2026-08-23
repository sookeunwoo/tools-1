/**
 * context-pack — 새 세션의 씨앗 (plan.md §13.4)
 *
 * 단답 continuation이 많은 건 게으름이 아니라 "새 세션을 열면 컨텍스트를 다시 만드는
 * 비용이 크다"는 합리적 회피다. 그 비용을 없애는 것이 이 툴의 유일한 목적이다.
 *
 * v0 범위: repo-map/trace-flow가 아직 없으므로 **git과 파일 구조에서 확인 가능한 사실만**
 * 조립한다. 호출 관계·트랜잭션 경계는 추측하지 않고 "모르는 것"에 명시한다 (P9).
 */

import { execFileSync } from 'node:child_process';
import { basename, extname, join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import type { Evidence, NextAction, ToolContext, ToolResult, Unresolved } from '#core/contract.ts';
import { DevkitError } from '#core/errors.ts';

type Input = {
  repo: string;
  task: string;
  ticket?: string;
  baseRef?: string;
  files?: string[];
  dod?: string[];
  budgetKb: number;
};

type ChangedFile = { path: string; added: number; deleted: number; isNew?: boolean };

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
  const git = makeGit(cwd, evidence);

  if (!git(['rev-parse', '--is-inside-work-tree']).ok) {
    throw new DevkitError({
      code: 'NOT_A_GIT_REPO',
      message: `${cwd} 는 git 저장소가 아닙니다`,
      hint: 'context-pack v0는 git diff를 근거로 씁니다.',
      retryable: false,
    });
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out || '(unknown)';
  const head = git(['rev-parse', '--short', 'HEAD']).out;
  const baseRef = input.baseRef ?? detectBaseRef(git, unresolved);

  // ── 대상 파일 ────────────────────────────────────────────────
  const changed = input.files
    ? input.files.map((path) => ({ path, added: 0, deleted: 0 }))
    : collectChanged(git, baseRef, cwd);

  const tracked = git(['ls-files']).out.split('\n').filter(Boolean);
  const { gaps, covered } = splitByTestCoverage(changed.map((c) => c.path), tracked);

  for (const file of changed.slice(0, 10)) {
    evidence.push({ kind: 'code', path: file.path, sha: head || undefined,
                    excerpt: `+${file.added}/-${file.deleted}` });
  }

  // ── 저장소 관례 ──────────────────────────────────────────────
  const commands = detectCommands(tracked);
  const dirty = git(['status', '--porcelain', '--untracked-files=all']).out.split('\n').filter(Boolean).length;
  const recent = baseRef ? git(['log', '--oneline', '-3', `${baseRef}..HEAD`]).out.split('\n').filter(Boolean) : [];

  // ── 모르는 것 (추측하지 않는다) ───────────────────────────────
  if (gaps.length > 0) {
    unresolved.push({
      reason: 'test-missing',
      at: gaps.slice(0, 5).join(', ') + (gaps.length > 5 ? ` 외 ${gaps.length - 5}개` : ''),
      hint: '대응하는 테스트 파일을 찾지 못했습니다. 이름 규칙이 다르거나 실제로 없습니다.',
    });
  }
  unresolved.push({
    reason: 'call-graph-unknown',
    at: 'context-pack v0',
    hint: '호출 관계·트랜잭션 경계·외부 시스템 의존은 확인하지 않았습니다. trace-flow(M1) 이후 채워집니다.',
  });

  // ── 브리핑 조립 ──────────────────────────────────────────────
  const budgetBytes = input.budgetKb * 1024;
  const { briefing, withinBudget, shownFiles } = assemble({
    input, branch, head, baseRef, changed, gaps, covered, commands, dirty, recent, budgetBytes,
  });

  const sizeBytes = Buffer.byteLength(briefing, 'utf8');
  const nextActions: NextAction[] = [];
  if (!withinBudget) {
    unresolved.push({
      reason: 'budget-exceeded',
      at: `${sizeBytes}B > ${budgetBytes}B`,
      hint: `대상 파일 ${changed.length}개 중 ${shownFiles}개만 실었습니다. files 입력으로 범위를 좁히세요.`,
    });
    nextActions.push({
      tool: 'context-pack',
      input: { repo: input.repo, task: input.task, files: changed.slice(0, 8).map((c) => c.path) },
      why: '브리핑이 예산을 넘겼습니다. 대상 파일을 좁혀 다시 만드세요',
    });
  }

  ctx.log('브리핑 생성', { sizeBytes, files: changed.length, gaps: gaps.length });

  return {
    data: {
      briefing,
      sizeBytes,
      withinBudget,
      targetFiles: changed.map((c) => ({ path: c.path, added: c.added, deleted: c.deleted })),
      testGaps: gaps,
    },
    evidence,
    unresolved,
    nextActions: nextActions.length ? nextActions : undefined,
    truncated: withinBudget ? undefined : { hasMore: true },
    // git 사실만 담았고 추론이 없다. 다만 테스트 파일 매칭은 이름 규칙 휴리스틱이다.
    confidence: gaps.length > 0 ? 0.9 : 1.0,
  };
}

// ── git ────────────────────────────────────────────────────────

function makeGit(cwd: string, evidence: Evidence[]) {
  return (args: string[]): { out: string; ok: boolean } => {
    try {
      const out = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      // ls-files와 파일별 라인 카운트는 건너뛴다 — 파일 수만큼 evidence가 불어난다
      if (args[0] !== 'ls-files' && !args.includes('--no-index')) {
        evidence.push({ kind: 'command', command: `git ${args.join(' ')}`, exitCode: 0,
                        excerpt: out.split('\n')[0]?.slice(0, 80) });
      }
      return { out, ok: true };
    } catch {
      return { out: '', ok: false };
    }
  };
}

/** origin/main → main → develop → HEAD~1 순으로 실재하는 것을 찾는다. */
function detectBaseRef(git: (a: string[]) => { out: string; ok: boolean }, unresolved: Unresolved[]): string {
  for (const ref of ['origin/main', 'origin/master', 'main', 'master', 'develop', 'HEAD~1']) {
    if (git(['rev-parse', '--verify', '--quiet', ref]).ok) return ref;
  }
  unresolved.push({
    reason: 'base-ref-not-found',
    at: 'detectBaseRef',
    hint: '비교 기준 브랜치를 찾지 못했습니다. baseRef를 직접 지정하세요.',
  });
  return '';
}

function collectChanged(git: (a: string[]) => { out: string; ok: boolean }, baseRef: string, cwd: string): ChangedFile[] {
  // 세 곳을 합친다. 세션 중간에 호출되므로 미커밋분과 신규 파일이 오히려 핵심이다.
  const args = baseRef ? ['diff', '--numstat', `${baseRef}...HEAD`] : ['diff', '--numstat', 'HEAD'];
  const committed = parseNumstat(git(args).out);
  const working = parseNumstat(git(['diff', '--numstat', 'HEAD']).out);

  // untracked 신규 파일 — git diff에 안 잡히는데 "지금 만들고 있는 파일"이라 가장 중요하다.
  const untracked = git(['ls-files', '--others', '--exclude-standard']).out
    .split('\n').filter(Boolean)
    .map((path) => ({ path, added: countLines(cwd, path), deleted: 0, isNew: true }));

  const merged = new Map<string, ChangedFile>();
  for (const f of [...committed, ...working, ...untracked]) {
    const prev = merged.get(f.path);
    merged.set(f.path, prev
      ? { ...f, added: prev.added + f.added, deleted: prev.deleted + f.deleted }
      : f);
  }
  return [...merged.values()].sort((a, b) => b.added + b.deleted - (a.added + a.deleted));
}

/**
 * untracked 파일의 라인 수.
 * `git diff --no-index`는 차이가 있으면 exit 1을 내서 항상 실패로 잡혔다(도그푸딩에서 발견).
 * git을 거치지 않고 직접 센다.
 */
function countLines(cwd: string, path: string): number {
  try {
    const stat = statSync(join(cwd, path));
    if (!stat.isFile() || stat.size > 1_000_000) return 0;
    const text = readFileSync(join(cwd, path), 'utf8');
    if (text.includes('\u0000')) return 0; // 바이너리
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}

function parseNumstat(out: string): ChangedFile[] {
  return out.split('\n').filter(Boolean).flatMap((line) => {
    const [a, d, path] = line.split('\t');
    if (!path) return [];
    return [{ path, added: Number(a) || 0, deleted: Number(d) || 0 }];
  });
}

// ── 테스트 커버 여부 (이름 규칙 휴리스틱) ────────────────────────

function splitByTestCoverage(paths: string[], tracked: string[]): { gaps: string[]; covered: string[] } {
  const gaps: string[] = [];
  const covered: string[] = [];
  const testFiles = new Set(tracked.filter(isTestFile).map((p) => basename(p)));

  for (const path of paths) {
    // 설정·문서·픽스처는 테스트 대상이 아니다. 여기 섞이면 DoD에 잘못된 항목이 생긴다.
    if (!isSourceFile(path)) continue;
    if (isTestFile(path)) { covered.push(path); continue; }
    const stem = basename(path, extname(path));
    const ext = extname(path);
    const candidates = [`${stem}Test${ext}`, `${stem}Spec${ext}`, `${stem}.test${ext}`, `${stem}.spec${ext}`];
    (candidates.some((c) => testFiles.has(c)) ? covered : gaps).push(path);
  }
  return { gaps, covered };
}

const SOURCE_EXT = new Set(['.kt', '.java', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.rb', '.scala', '.swift']);

function isSourceFile(path: string): boolean {
  return SOURCE_EXT.has(extname(path));
}

function isTestFile(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)\//.test(path) || /(Test|Spec)\.\w+$/.test(path) || /\.(test|spec)\.\w+$/.test(path);
}

// ── 저장소 관례 ────────────────────────────────────────────────

function detectCommands(tracked: string[]): { build?: string; test?: string } {
  const has = (f: string) => tracked.some((p) => p === f || p.endsWith(`/${f}`));
  if (has('gradlew')) return { build: './gradlew build', test: './gradlew test' };
  if (has('pom.xml')) return { build: 'mvn compile', test: 'mvn test' };
  if (has('package.json')) return { build: 'npm run build', test: 'npm test' };
  if (has('Cargo.toml')) return { build: 'cargo build', test: 'cargo test' };
  return {};
}

// ── 브리핑 ─────────────────────────────────────────────────────

type AssembleArgs = {
  input: Input; branch: string; head: string; baseRef: string;
  changed: ChangedFile[]; gaps: string[]; covered: string[];
  commands: { build?: string; test?: string }; dirty: number; recent: string[]; budgetBytes: number;
};

function assemble(a: AssembleArgs): { briefing: string; withinBudget: boolean; shownFiles: number } {
  // 파일 수를 줄여가며 예산에 맞춘다. 다른 섹션은 짧고 전부 필수라 건드리지 않는다.
  for (const limit of [a.changed.length, 20, 12, 8, 5, 3]) {
    const text = render(a, limit);
    if (Buffer.byteLength(text, 'utf8') <= a.budgetBytes) {
      return { briefing: text, withinBudget: true, shownFiles: Math.min(limit, a.changed.length) };
    }
  }
  return { briefing: render(a, 3), withinBudget: false, shownFiles: Math.min(3, a.changed.length) };
}

function render(a: AssembleArgs, fileLimit: number): string {
  const { input, changed, gaps, commands } = a;
  const L: string[] = [];

  L.push(`## 작업${input.ticket ? `: ${input.ticket}` : ''} — ${input.task}`);

  L.push('', '## 대상 파일 (이것만 건드린다)');
  if (changed.length === 0) {
    L.push(`- (변경 없음 — ${a.baseRef || 'HEAD'} 기준으로 깨끗함. 새로 시작하는 작업이다)`);
  } else {
    for (const f of changed.slice(0, fileLimit)) {
      const mark = f.isNew ? ' **(신규)**' : '';
      L.push(`- \`${f.path}\`${f.added || f.deleted ? ` (+${f.added}/-${f.deleted})` : ''}${mark}`);
    }
    if (changed.length > fileLimit) L.push(`- … 외 ${changed.length - fileLimit}개 (범위를 좁히는 게 좋다)`);
  }

  L.push('', '## 확인된 사실 (git 근거)');
  L.push(`- 브랜치 \`${a.branch}\`${a.head ? ` @ ${a.head}` : ''}${a.baseRef ? `, 기준 \`${a.baseRef}\`` : ''}`);
  if (a.dirty > 0) L.push(`- 미커밋 변경 ${a.dirty}개 파일 — 세션 시작 전 커밋 여부를 정할 것`);
  if (commands.test) L.push(`- 빌드 \`${commands.build}\` / 테스트 \`${commands.test}\``);
  if (a.recent.length > 0) {
    L.push('- 이 브랜치의 최근 커밋:');
    for (const c of a.recent) L.push(`  - ${c}`);
  }

  L.push('', '## 완료 기준 (DoD)');
  for (const d of input.dod ?? []) L.push(`- [ ] ${d}`);
  if (gaps.length > 0) L.push(`- [ ] 테스트 없는 변경 파일 ${gaps.length}개에 테스트 추가`);
  if (commands.test) L.push(`- [ ] \`${commands.test}\` 통과`);
  L.push('- [ ] 변경 라인 커버리지 확인 (coverage-diff, M3 예정)');

  L.push('', '## 모르는 것 (직접 확인 필요)');
  if (gaps.length > 0) {
    L.push(`- 대응 테스트를 못 찾은 파일: ${gaps.slice(0, 5).map((g) => `\`${basename(g)}\``).join(', ')}` +
           (gaps.length > 5 ? ` 외 ${gaps.length - 5}개` : ''));
  }
  L.push('- 호출 관계·트랜잭션 경계·외부 시스템 의존은 **확인하지 않았다** (trace-flow 이후)');
  L.push('- 위 "확인된 사실"은 git에서 나온 것만이다. 도메인 규칙은 직접 읽어야 한다');

  return L.join('\n') + '\n';
}
