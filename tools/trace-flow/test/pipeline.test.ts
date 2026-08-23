/**
 * repo-map → trace-flow 파이프라인 통합 테스트.
 *
 * 임시 Kotlin/Spring 저장소를 만들어 실행 파이프라인을 그대로 통과시킨다.
 * 여기서 보는 건 "그래프가 사실인가"다 — 틀린 그래프는 설계 문서로 전파되어
 * 잘못된 전제에서 구현이 시작된다.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let home: string;
let repo: string;

const SOURCE = `
package com.example

@RestController
@RequestMapping("/v1/orders")
class OrderController(
    private val orderService: OrderService,
) {
    @PostMapping("/{id}/confirm")
    fun confirm(id: Long): Any = orderService.confirm(id)

    @GetMapping
    fun list(): Any = orderService.findAll()
}

@Service
class OrderService(
    private val orderRepository: OrderRepository,
    private val payClient: PayClient,
) {
    @Transactional
    fun confirm(id: Long): Any {
        val order = orderRepository.findById(id)
        payClient.approve(order)
        return orderRepository.save(order)
    }

    @Transactional(readOnly = true)
    fun findAll(): Any = orderRepository.findAll()

    @Transactional(readOnly = true)
    fun broken(): Any = orderRepository.save(null)
}

@Entity
@Table(name = "orders")
class Order

@Repository
interface OrderRepository

interface PaymentPort { fun charge(a: Long) }

@Component
class TossAdapter(private val http: HttpClient) : PaymentPort {
    override fun charge(a: Long) { http.post("/t") }
}

@Component
class KakaoAdapter(private val http: HttpClient) : PaymentPort {
    override fun charge(a: Long) { http.post("/k") }
}

@Service
class CheckoutService(private val paymentPort: PaymentPort) {
    fun pay(a: Long) { paymentPort.charge(a) }
}
`;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'devkit-tf-home-'));
  repo = mkdtempSync(join(tmpdir(), 'devkit-tf-repo-'));
  process.env.DEVKIT_HOME = home;

  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/App.kt'), SOURCE);
  const git = (a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@e.com']);
  git(['config', 'user.name', 't']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'init']);

  writeFileSync(join(home, 'config.toml'), `[repos.fx]\npath = "${repo}"\nlang = ["kotlin"]\n`);
});

after(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

async function run(tool: string, input: Record<string, unknown>) {
  const { execute } = await import('#registry/execute.ts');
  return (await execute(tool, { repo: 'fx', ...input }, { agentId: 'tf-test', refresh: true })) as any;
}

test('repo-map: 타입·엔드포인트를 인덱싱한다', async () => {
  const env = await run('repo-map', { listEndpoints: true });
  assert.ok(env.data.counts.types >= 8, `타입이 ${env.data.counts.types}개뿐입니다`);
  const keys = env.data.endpoints.map((e: { key: string }) => e.key);
  assert.ok(keys.includes('POST /v1/orders/{id}/confirm'));
  assert.ok(keys.includes('GET /v1/orders'));
});

test('trace-flow: 인덱스 없이 호출하면 고치는 명령을 알려준다', async () => {
  const { execute } = await import('#registry/execute.ts');
  const { rmSync: rm } = await import('node:fs');
  const { indexPath } = await import('#lang/store.ts');
  rm(indexPath('fx'), { force: true });

  await assert.rejects(
    () => execute('trace-flow', { repo: 'fx', entry: 'GET /v1/orders' }, { agentId: 'tf-test' }),
    (e: { code?: string; fixCommand?: string }) => {
      assert.equal(e.code, 'REPO_INDEX_MISSING');
      assert.match(e.fixCommand!, /repo-map/);
      return true;
    },
  );
  await run('repo-map', {}); // 이후 테스트를 위해 복구
});

test('trace-flow: 엔드포인트에서 리포지토리까지 흐름을 따라간다', async () => {
  const env = await run('trace-flow', { entry: 'POST /v1/orders/{id}/confirm' });
  const ids = env.data.nodes.map((n: { id: string }) => n.id);

  assert.ok(ids.includes('OrderController.confirm'), '진입점 노드가 없습니다');
  assert.ok(ids.includes('OrderService.confirm'), 'DI 필드로 서비스를 해석하지 못했습니다');
  assert.ok(ids.includes('OrderRepository.findById'), '리포지토리 호출을 해석하지 못했습니다');
});

test('trace-flow: 그래프에 댕글링 참조가 없다', async () => {
  const env = await run('trace-flow', { entry: 'POST /v1/orders/{id}/confirm' });
  const ids = new Set(env.data.nodes.map((n: { id: string }) => n.id));
  for (const e of env.data.edges) {
    assert.ok(ids.has(e.from), `edge.from ${e.from} 이 nodes에 없습니다`);
    assert.ok(ids.has(e.to), `edge.to ${e.to} 이 nodes에 없습니다`);
  }
});

test('trace-flow: @Table 어노테이션에서 실제 테이블명을 읽는다', async () => {
  const env = await run('trace-flow', { entry: 'POST /v1/orders/{id}/confirm' });
  const table = env.data.tables.find((t: { name: string }) => t.name === 'orders');
  assert.ok(table, `테이블을 못 찾았습니다: ${JSON.stringify(env.data.tables)}`);
  assert.ok(table.ops.includes('write') && table.ops.includes('read'));
});

test('trace-flow: 트랜잭션 안의 외부 호출을 high 리스크로 잡는다', async () => {
  const env = await run('trace-flow', { entry: 'POST /v1/orders/{id}/confirm' });
  const risk = env.data.riskPoints.find((r: { why: string }) => r.why.includes('트랜잭션 경계 안에서 외부 시스템'));
  assert.ok(risk, `리스크를 못 잡았습니다: ${JSON.stringify(env.data.riskPoints)}`);
  assert.equal(risk.severity, 'high');
});

test('trace-flow: readOnly 트랜잭션의 쓰기 호출을 잡는다', async () => {
  const env = await run('trace-flow', { entry: 'OrderService.broken' });
  assert.ok(
    env.data.riskPoints.some((r: { why: string }) => r.why.includes('readOnly')),
    `readOnly 위반을 못 잡았습니다: ${JSON.stringify(env.data.riskPoints)}`,
  );
});

test('trace-flow: 인터페이스 구현체가 여럿이면 분기하고 신뢰도를 낮춘다', async () => {
  const env = await run('trace-flow', { entry: 'CheckoutService.pay' });
  const branched = env.data.edges.filter((e: { to: string }) => /Adapter\.charge$/.test(e.to));

  assert.equal(branched.length, 2, '두 구현체로 분기하지 않았습니다');
  assert.ok(branched.every((e: { confidence: number }) => e.confidence < 1));
  assert.ok(env.confidence < 1, '분기했는데 confidence가 1입니다 — 정직하지 않습니다');
  assert.ok(env.unresolved.some((u: { reason: string }) => u.reason === 'multiple-implementations'));
});

test('trace-flow: 없는 진입점은 사용 가능한 목록을 알려준다', async () => {
  const { execute } = await import('#registry/execute.ts');
  await assert.rejects(
    () => execute('trace-flow', { repo: 'fx', entry: 'DELETE /없음' }, { agentId: 'tf-test' }),
    (e: { code?: string; hint?: string }) => {
      assert.equal(e.code, 'ENTRY_NOT_FOUND');
      assert.match(e.hint!, /v1\/orders/);
      return true;
    },
  );
});

test('trace-flow: 스캐너 한계를 항상 밝힌다 (P9)', async () => {
  const env = await run('trace-flow', { entry: 'GET /v1/orders' });
  assert.ok(env.unresolved.some((u: { reason: string }) => u.reason === 'scanner-tier-1'));
  assert.ok(env.evidence.length > 0);
});
