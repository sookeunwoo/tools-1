#!/usr/bin/env node
/**
 * `dk` — devkit CLI.
 *
 * 설계원칙 P1: CLI가 1급 surface다. MCP는 이 위의 얇은 어댑터일 뿐이다.
 * 에이전트가 툴 버그를 고칠 때 CLI로 직접 재현·디버깅해야 하기 때문이다.
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { createReadStream, watchFile } from 'node:fs';
import { dirname } from 'node:path';
import { toDevkitError } from '#core/errors.ts';
import { globalConfigPath, runsLogPath, devkitHome } from '#core/paths.ts';
import { listRuns, toolStats } from '#core/ledger.ts';
import { activeLeases } from '#core/lease.ts';
import * as cache from '#core/cache.ts';
import { listTools, getTool } from '#registry/registry.ts';
import { execute, type ExecuteOptions } from '#registry/execute.ts';
import { runTests } from './fixtures.ts';
import { diagnose } from './doctor.ts';
import { scaffoldTool } from './scaffold.ts';

type Args = { _: string[]; flags: Record<string, string | boolean> };

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'help';

  switch (command) {
    case 'run': return await cmdRun(args);
    case 'list': case 'tools': return cmdList(args);
    case 'describe': return cmdDescribe(args);
    case 'ps': return cmdPs(args);
    case 'runs': return cmdRuns(args);
    case 'stats': return cmdStats(args);
    case 'tail': return await cmdTail(args);
    case 'doctor': return cmdDoctor(args);
    case 'test': return await cmdTest(args);
    case 'scaffold': return cmdScaffold(args);
    case 'init': return cmdInit();
    case 'cache': return cmdCache(args);
    case 'mcp': { await (await import('../../mcp/src/stdio.ts')).serve(); return 0; }
    case 'help': default: return cmdHelp();
  }
}

async function cmdRun(args: Args): Promise<number> {
  const tool = args._[1];
  if (!tool) return fail('사용법: dk run <tool> --input <json|@file|->');

  const input = readInput(args.flags.input);
  const opts: ExecuteOptions = {
    agentId: str(args.flags.agent),
    explain: !!args.flags.explain,
    refresh: !!args.flags.refresh,
    recordInput: !!args.flags['record-input'],
    idempotencyKey: str(args.flags['idempotency-key']),
    approvalToken: str(args.flags.approve),
    leaseWaitMs: args.flags.wait ? Number(args.flags.wait) : 0,
    profile: str(args.flags.profile),
  };
  if (args.flags.trace) process.env.DEVKIT_TRACE = '1';

  const result = await execute(tool, input, opts);
  // 에이전트가 파싱하기 쉽도록 결과는 항상 JSON으로 stdout에 낸다.
  process.stdout.write(JSON.stringify(result, null, args.flags.compact ? 0 : 2) + '\n');
  return 0;
}

function cmdList(args: Args): number {
  const tools = listTools();
  if (args.flags.json) return json(tools.map((t) => t.manifest));
  if (tools.length === 0) return info('등록된 툴이 없습니다. `dk scaffold tool <name>` 으로 만드세요.');
  for (const { manifest: m } of tools) {
    const marks = [m.sideEffects, m.concurrency.mode === 'exclusive' ? '배타' : null, m.requiresApproval ? '승인필요' : null]
      .filter(Boolean).join(', ');
    console.log(`${pad(m.name, 18)} ${pad(`v${m.version}`, 8)} ${m.summary}  (${marks})`);
  }
  return 0;
}

function cmdDescribe(args: Args): number {
  const name = args._[1];
  if (!name) return fail('사용법: dk describe <tool>');
  const { manifest, dir } = getTool(name);
  if (args.flags.json) return json(manifest);
  console.log(`${manifest.name} v${manifest.version}\n  ${manifest.summary}\n`);
  console.log(`언제 쓰는가:\n  ${manifest.whenToUse}\n`);
  console.log(`부수효과: ${manifest.sideEffects} | 동시성: ${manifest.concurrency.mode}${manifest.concurrency.resourceKey ? ` (${manifest.concurrency.resourceKey})` : ''}`);
  console.log(`결정성: ${manifest.determinism} | 타임아웃: ${manifest.timeoutSec}s | 승인필요: ${manifest.requiresApproval}`);
  console.log(`\n입력 스키마:\n${indent(JSON.stringify(manifest.inputSchema, null, 2))}`);
  console.log(`\n구현: ${dir}/index.ts`);
  return 0;
}

function cmdPs(args: Args): number {
  const running = listRuns({ status: 'running', limit: 50 });
  const leases = activeLeases();
  if (args.flags.json) return json({ running, leases });

  if (running.length === 0) console.log('실행 중인 툴이 없습니다.');
  else {
    console.log('실행 중:');
    for (const r of running) {
      console.log(`  ${pad(r.tool, 18)} ${pad(r.agent_id, 12)} ${Math.round((Date.now() - r.started_at) / 1000)}s  ${r.run_id.slice(0, 8)}`);
    }
  }
  if (leases.length > 0) {
    console.log('\n점유 중인 자원:');
    for (const l of leases) {
      console.log(`  ${pad(l.resourceKey, 28)} ${pad(l.ownerAgent, 12)} ${Math.max(0, Math.round((l.expiresAt - Date.now()) / 1000))}s 후 만료`);
    }
  }
  return 0;
}

function cmdRuns(args: Args): number {
  const rows = listRuns({
    limit: args.flags.limit ? Number(args.flags.limit) : 20,
    tool: str(args.flags.tool),
    status: str(args.flags.status) as never,
    sinceMs: parseDuration(str(args.flags.since) ?? '7d'),
  });
  if (args.flags.json) return json(rows);
  for (const r of rows) {
    const mark = r.status === 'ok' ? '✓' : r.status === 'running' ? '…' : '✗';
    const dur = r.duration_ms === null ? '-' : `${r.duration_ms}ms`;
    console.log(
      `${mark} ${new Date(r.started_at).toISOString().slice(11, 19)} ${pad(r.tool, 18)} ${pad(dur, 9)}` +
      `${r.cache_hit ? ' [cache]' : ''}${r.error_code ? ` ${r.error_code}` : ''} ${r.run_id.slice(0, 8)}`,
    );
  }
  if (rows.length === 0) console.log('기록이 없습니다.');
  return 0;
}

function cmdStats(args: Args): number {
  const sinceMs = parseDuration(str(args.flags.since) ?? '7d');
  const stats = toolStats(sinceMs);
  if (args.flags.json) return json(stats);
  if (stats.length === 0) return info('집계할 실행 기록이 없습니다.');
  console.log(`${pad('툴', 18)} ${pad('호출', 6)} ${pad('성공률', 8)} ${pad('p50', 8)} ${pad('p95', 8)} ${pad('캐시', 7)} 신뢰도`);
  for (const s of stats) {
    console.log(
      `${pad(s.tool, 18)} ${pad(String(s.calls), 6)} ${pad(`${Math.round(s.successRate * 100)}%`, 8)}` +
      ` ${pad(s.p50Ms === null ? '-' : `${s.p50Ms}ms`, 8)} ${pad(s.p95Ms === null ? '-' : `${s.p95Ms}ms`, 8)}` +
      ` ${pad(`${Math.round(s.cacheHitRate * 100)}%`, 7)} ${s.avgConfidence === null ? '-' : s.avgConfidence.toFixed(2)}`,
    );
  }
  return 0;
}

async function cmdTail(args: Args): Promise<number> {
  const path = runsLogPath();
  if (!existsSync(path)) return info(`아직 로그가 없습니다: ${path}`);
  await printLines(path, 0);
  if (!args.flags.f && !args.flags.follow) return 0;

  let offset = Buffer.byteLength(readFileSync(path));
  watchFile(path, { interval: 300 }, async (curr) => {
    if (curr.size > offset) {
      await printLines(path, offset);
      offset = curr.size;
    }
  });
  return await new Promise(() => {}); // Ctrl-C까지 유지
}

function cmdDoctor(args: Args): number {
  const checks = diagnose();
  if (args.flags.json) return json(checks);
  let failed = 0;
  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${pad(c.name, 26)} ${c.detail}`);
    if (!c.ok) {
      failed++;
      if (c.fixCommand) console.log(`    고치기: ${c.fixCommand}`);
    }
  }
  console.log(`\n${checks.length - failed}/${checks.length} 통과`);
  return failed > 0 ? 1 : 0;
}

async function cmdTest(args: Args): Promise<number> {
  const results = await runTests(args._[1]);
  if (args.flags.json) return json(results);
  const failures = results.filter((r) => !r.ok);
  for (const r of results) {
    if (!r.ok || args.flags.verbose) {
      console.log(`${r.ok ? '✓' : '✗'} [${r.kind}] ${r.tool} — ${r.name}${r.detail ? `\n    ${r.detail}` : ''}`);
    }
  }
  console.log(`\n${results.length - failures.length}/${results.length} 통과${failures.length ? ` — ${failures.length}개 실패` : ''}`);
  return failures.length > 0 ? 1 : 0;
}

function cmdScaffold(args: Args): number {
  if (args._[1] !== 'tool' || !args._[2]) return fail('사용법: dk scaffold tool <name> [--summary "..."]');
  const dir = scaffoldTool(args._[2], str(args.flags.summary));
  console.log(`생성됨: ${dir}`);
  console.log(`다음: manifest.json 의 whenToUse/스키마를 채우고, index.ts 를 구현한 뒤 \`dk test ${args._[2]}\``);
  return 0;
}

function cmdInit(): number {
  const path = globalConfigPath();
  if (existsSync(path)) return info(`이미 있습니다: ${path}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `# devkit 설정 — 시크릿 값은 절대 여기 넣지 않는다 (keychain:// 참조만)
default_profile = "personal"

# [repos.my-service]
# path = "~/IdeaProjects/my-service"
# lang = ["kotlin"]
# framework = ["spring-boot"]
# entrypoint_globs = ["**/*Controller.kt", "**/*Listener.kt"]

[policy]
# allow_tools = []          # 비우면 전체 허용
deny_tools = []
allow_prod_writes = false
approvals = []
`);
  console.log(`생성됨: ${path}`);
  console.log(`다음: [repos.<name>] 블록을 채우고 \`dk doctor\``);
  return 0;
}

function cmdCache(args: Args): number {
  const sub = args._[1];
  if (sub === 'clear') return info(`캐시 ${cache.clear()}건 삭제`);
  if (sub === 'invalidate' && args._[2]) return info(`'${args._[2]}' 캐시 ${cache.invalidateTool(args._[2])}건 삭제`);
  return fail('사용법: dk cache clear | dk cache invalidate <tool>');
}

function cmdHelp(): number {
  console.log(`dk — devkit CLI (${devkitHome()})

  dk run <tool> --input '<json>'   툴 실행. --explain(계획만) --refresh(캐시무시)
                                   --agent <id> --wait <ms> --trace --record-input
  dk list                          등록된 툴
  dk describe <tool>               계약(입출력 스키마) 확인
  dk ps                            실행 중인 툴 + 점유 자원
  dk runs [--since 7d --tool X]    실행 이력
  dk stats [--since 7d]            툴별 지표 (성공률/p50/p95/캐시/신뢰도)
  dk tail [-f]                     감사 로그 스트림
  dk test [tool]                   골든 픽스처 + 계약 테스트
  dk doctor                        환경 진단 (각 문제에 고치는 명령 포함)
  dk scaffold tool <name>          새 툴 뼈대
  dk init                          전역 설정 생성
  dk cache clear|invalidate <tool>
  dk mcp                           MCP stdio 서버 시작

  모든 명령에 --json 사용 가능 (에이전트용).
`);
  return 0;
}

// ── helpers ──────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [key, inline] = splitOnce(a.slice(2), '=');
      if (inline !== undefined) out.flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) out.flags[key] = argv[++i];
      else out.flags[key] = true;
    } else if (a.startsWith('-') && a.length === 2) {
      out.flags[a.slice(1)] = true;
    } else out._.push(a);
  }
  return out;
}

function splitOnce(s: string, sep: string): [string, string | undefined] {
  const i = s.indexOf(sep);
  return i === -1 ? [s, undefined] : [s.slice(0, i), s.slice(i + 1)];
}

/** --input 은 인라인 JSON, @파일, - (stdin)을 받는다. */
function readInput(flag: string | boolean | undefined): unknown {
  if (flag === undefined || flag === true) return {};
  const raw = String(flag);
  const text = raw === '-' ? readFileSync(0, 'utf8') : raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw toDevkitError({
      code: 'INPUT_NOT_JSON',
      message: `--input 을 JSON으로 파싱할 수 없습니다: ${(err as Error).message}`,
    });
  }
}

async function printLines(path: string, from: number): Promise<void> {
  const rl = createInterface({ input: createReadStream(path, { start: from }), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) console.log(line);
}

function parseDuration(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)([smhd])$/);
  if (!m) return Number(s) || 7 * 86400_000;
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]] ?? 1;
  return Number(m[1]) * mult;
}

const pad = (s: string, n: number) => s.padEnd(n);
const indent = (s: string) => s.split('\n').map((l) => '  ' + l).join('\n');
const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);
const json = (v: unknown) => (process.stdout.write(JSON.stringify(v, null, 2) + '\n'), 0);
const info = (m: string) => (console.log(m), 0);
const fail = (m: string) => (console.error(m), 1);

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    const e = toDevkitError(err);
    // 에이전트가 파싱할 수 있도록 에러도 구조화해서 stderr에 낸다.
    process.stderr.write(JSON.stringify({ ok: false, error: e.toJSON() }, null, 2) + '\n');
    process.exit(1);
  });
