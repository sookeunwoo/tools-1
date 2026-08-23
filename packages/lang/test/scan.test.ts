/**
 * 어휘 스캐너 테스트.
 *
 * 대부분이 **도그푸딩에서 실제로 터진 버그의 회귀 테스트**다.
 * 스캐너가 틀리면 repo-map과 trace-flow가 조용히 틀린 그래프를 만든다 —
 * 이 계층의 오류가 가장 비싸다.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanJvm } from '#lang/jvm.ts';
import { scanTypeScript } from '#lang/typescript.ts';
import type { ScanGap } from '#lang/types.ts';

function kt(src: string) {
  const gaps: ScanGap[] = [];
  return { r: scanJvm('T.kt', src, 'kotlin', gaps), gaps };
}
const typeOf = (r: ReturnType<typeof kt>['r'], name: string) => r.types.find((t) => t.name === name)!;

test('주석과 문자열 안의 코드는 심볼로 잡히지 않는다', () => {
  const { r } = kt(`
    // fun ghostA()
    /* fun ghostB() */
    class A {
      fun real() { val s = "fun ghostC() @Transactional" }
    }
  `);
  const names = typeOf(r, 'A').methods.map((m) => m.name);
  assert.deepEqual(names, ['real']);
  assert.equal(typeOf(r, 'A').methods[0].calls.length, 0, '문자열 안의 호출이 잡혔습니다');
});

// 회귀: 주 생성자 파라미터 타입이 상위타입으로 잡혀 구현체 조회가 통째로 오염됐다
test('주 생성자 파라미터는 상위타입이 아니라 DI 필드다', () => {
  const { r } = kt(`
    class OrderService(
        private val orderRepository: OrderRepository,
        private val payClient: PayClient,
    ) : BaseService(), Auditable {
        fun run() {}
    }
  `);
  const t = typeOf(r, 'OrderService');
  assert.deepEqual(t.supertypes, ['BaseService', 'Auditable'], '생성자 파라미터가 상위타입으로 샜습니다');
  assert.deepEqual(t.fields.map((f) => `${f.name}:${f.type}`), ['orderRepository:OrderRepository', 'payClient:PayClient']);
});

test('생성자가 없는 클래스의 상위타입도 읽는다', () => {
  const { r } = kt(`class Impl : Port { fun go() {} }`);
  assert.deepEqual(typeOf(r, 'Impl').supertypes, ['Port']);
});

test('Java extends/implements를 읽는다', () => {
  const gaps: ScanGap[] = [];
  const r = scanJvm('T.java', 'public class Foo extends Base implements Bar, Baz { public void go() { dep.call(); } }', 'java', gaps);
  assert.deepEqual(r.types[0].supertypes, ['Base', 'Bar', 'Baz']);
});

// 회귀: `= repo.findAll().map { ... }` 의 람다 `{` 를 메서드 본문으로 오인해 호출을 놓쳤다
test('표현식 본문에 람다가 있어도 호출을 잡는다', () => {
  const { r } = kt(`
    class A(private val repo: Repo) {
      fun all(): List<X> = repo.findAll().map { X(it) }
      fun one(): X = repo.findById(1)
    }
  `);
  const calls = typeOf(r, 'A').methods.flatMap((m) => m.calls.map((c) => `${c.receiver}.${c.method}`));
  assert.ok(calls.includes('repo.findAll'), '람다가 붙은 표현식 본문의 호출을 놓쳤습니다');
  assert.ok(calls.includes('repo.findById'));
});

// 회귀: 본문 없는 선언을 통째로 버려서 @Entity/@Table과 구현 관계가 인덱스에서 사라졌다
test('본문 없는 타입 선언도 인덱싱된다', () => {
  const { r, gaps } = kt(`
    @Entity
    @Table(name = "orders")
    class Order

    @Repository
    interface OrderRepository
  `);
  assert.ok(typeOf(r, 'Order'), '@Entity 클래스가 인덱스에서 빠졌습니다');
  assert.ok(typeOf(r, 'OrderRepository'), '마커 인터페이스가 인덱스에서 빠졌습니다');
  assert.ok(gaps.some((g) => g.reason === 'type-body-absent'), '본문 없음을 gap으로 보고하지 않았습니다');
});

// 회귀: 중괄호 없는 선언이 앞에 있으면 그 어노테이션이 다음 타입으로 샜다
test('어노테이션이 다음 타입으로 새지 않는다', () => {
  const { r } = kt(`
    @Entity
    @Table(name = "orders")
    class Order

    @Repository
    interface OrderRepository
  `);
  assert.deepEqual(typeOf(r, 'OrderRepository').annotations.map((a) => a.name), ['Repository']);
  assert.deepEqual(typeOf(r, 'Order').annotations.map((a) => a.name), ['Entity', 'Table']);
});

test('어노테이션 인자는 원본에서 읽는다 (문자열이 지워졌어도)', () => {
  const { r } = kt(`@Table(name = "orders") class Order { fun x() {} }`);
  assert.match(typeOf(r, 'Order').annotations.find((a) => a.name === 'Table')!.args!, /orders/);
});

test('Spring 엔드포인트 경로를 클래스+메서드로 조합한다', () => {
  const { r } = kt(`
    @RestController
    @RequestMapping("/v1/orders")
    class C {
      @PostMapping("/{id}/confirm") fun confirm() {}
      @GetMapping fun list() {}
      @KafkaListener(topics = ["order.created"]) fun onCreated() {}
      @Scheduled(cron = "0 0 * * * *") fun sweep() {}
    }
  `);
  const keys = r.endpoints.map((e) => e.key);
  assert.ok(keys.includes('POST /v1/orders/{id}/confirm'));
  assert.ok(keys.includes('GET /v1/orders'));
  assert.ok(keys.some((k) => k.startsWith('KafkaListener order.created')));
  assert.ok(keys.some((k) => k.startsWith('Scheduled')));
});

test('@RestController가 아니면 HTTP 엔드포인트로 보지 않는다', () => {
  const { r } = kt(`class NotAController { @GetMapping fun x() {} }`);
  assert.equal(r.endpoints.filter((e) => e.kind === 'http').length, 0);
});

test('제어 구문은 호출로 세지 않는다', () => {
  const { r } = kt(`class A { fun go() { if (x) { for (i in y) { svc.doIt() } } } }`);
  const calls = typeOf(r, 'A').methods[0].calls.map((c) => c.method);
  assert.deepEqual(calls, ['doIt']);
});

test('TypeScript: Next.js 라우트를 엔드포인트로 잡는다', () => {
  const gaps: ScanGap[] = [];
  const r = scanTypeScript('src/app/api/orders/route.ts', `
    export async function GET(req: Request) { return svc.list(); }
    export async function POST(req: Request) { return svc.create(); }
  `, gaps);
  assert.deepEqual(r.endpoints.map((e) => e.key).sort(), ['GET /api/orders', 'POST /api/orders']);
});
