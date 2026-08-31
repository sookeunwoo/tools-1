# trace-flow

엔드포인트에서 **다운스트림까지의 호출 흐름과 리스크 포인트**를 추적한다.

## 왜 있는가

"이 API가 무엇을 건드리는가"(DB 테이블·외부 시스템·이벤트·트랜잭션 경계)를 알아내려고
코드를 수십 번 읽는 걸 툴 한 번으로 대체한다.

## 사용

```bash
# 1. 인덱스를 먼저 만든다
dk run repo-map --input '{"repo":"my-service"}'

# 2. 흐름 추적
dk run trace-flow --input '{"repo":"my-service","entry":"POST /v1/orders/{id}/confirm"}'
dk run trace-flow --input '{"repo":"my-service","entry":"OrderService.confirm","mode":"full"}'
```

| 입력 | 설명 |
|---|---|
| `repo` (필수) | 설정에 등록된 저장소 이름 |
| `entry` (필수) | `"POST /v1/orders"` 같은 엔드포인트 키 또는 `"OrderService.confirm"` |
| `maxDepth` | 기본 6 |
| `mode` | `summary`(기본) / `full` |

진입점을 못 찾으면 **사용 가능한 엔드포인트 목록**을 에러 `hint`로 돌려준다.

## 출력 예시

```jsonc
{
  "entry": { "key": "POST /v1/orders/{id}/confirm", "kind": "http", "path": "src/OrderController.kt", "line": 14 },
  "nodes": [
    { "id": "OrderController.confirm", "kind": "endpoint", "depth": 0 },
    { "id": "OrderService.confirm", "kind": "service", "depth": 1,
      "transactional": { "readOnly": false, "propagation": "REQUIRED" } },
    { "id": "OrderRepository.save", "kind": "repository", "depth": 2 },
    { "id": "PayClient.approve", "kind": "external", "depth": 2 }
  ],
  "edges": [ { "from": "OrderService.confirm", "to": "PayClient.approve", "line": 33, "confidence": 1 } ],
  "tables": [ { "name": "orders", "ops": ["read", "write"] } ],
  "externals": [ { "name": "PayClient", "method": "approve", "via": "OrderService.confirm", "line": 33 } ],
  "riskPoints": [
    { "severity": "high", "at": "OrderService.confirm → PayClient.approve", "line": 33,
      "why": "트랜잭션 경계 안에서 외부 시스템을 호출합니다 — 커넥션 점유 + 롤백 시 보상 없음" }
  ]
}
```

## 리스크 룰

| 심각도 | 규칙 |
|---|---|
| high | `@Transactional` 경계 안에서 외부 시스템 호출 (커넥션 점유 + 롤백 시 보상 없음) |
| high | `@Transactional(readOnly = true)` 안에서 쓰기 메서드 호출 |
| medium | 반복 호출(`forEach`/`map`) 구간에서 리포지토리 호출 — N+1 의심 |
| medium | 쓰기 엔드포인트(POST/PUT/PATCH)에 멱등성 키가 없음 |
| low | 외부 호출에 재시도 설정이 보이지 않음 |

`tables`의 이름은 `@Table(name = "…")`이 있으면 그 값을, 없으면 엔티티명을 snake_case로 변환해 쓴다.

## 해석 전략과 한계

**타입 추론을 하지 않는다.** DI 필드의 **선언 타입 + 메서드명**만으로 수신자를 정한다.

- 인터페이스에 구현체가 여럿이면 **전부 분기**하고 각 엣지의 `confidence`를 나눈다.
  전체 `confidence`도 함께 낮추고 `unresolved`에 `multiple-implementations`로 남긴다.
- 지역 변수·메서드 체이닝의 수신자는 못 푼다 → `unresolved`의 `receiver-unresolved`.
- 인덱스에 없는 타입(외부 라이브러리)은 **잎 노드**로 남긴다. 그래야 `edges`가
  존재하지 않는 노드를 가리키지 않는다.
- 리플렉션·동적 프록시·AOP는 보이지 않는다 → 항상 `scanner-tier-1`로 보고한다.

> **`confidence`와 `unresolved`를 반드시 확인하고 쓸 것.** 이 툴은 "모른다"고 말하도록
> 설계돼 있다. 조용히 틀린 그래프가 "모르겠다"보다 훨씬 나쁘기 때문이다.

## 테스트

```bash
dk test trace-flow
node --test plugins/trace-flow/test/pipeline.test.ts   # 임시 Kotlin 저장소로 end-to-end
```
