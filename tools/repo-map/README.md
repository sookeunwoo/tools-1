# repo-map

저장소의 **타입·메서드·엔드포인트·의존성 인덱스**를 만든다. `trace-flow`의 전제 조건이다.

## 왜 있는가

에이전트가 "이 코드베이스에 뭐가 있나"를 알아내려고 `Bash`/`Read`를 수백 번 호출하는 걸 없앤다.
한 번 스캔해 **커밋 SHA 기준으로 캐시**하고, 이후 조회는 인덱스에서만 한다.

## 사용

```bash
dk run repo-map --input '{"repo":"my-service"}'
dk run repo-map --input '{"repo":"my-service","listEndpoints":true}'   # 엔드포인트 목록까지
dk run repo-map --input '{"repo":"my-service","include":["module-a/"]}' # 멀티모듈 일부만
dk run repo-map --input '{"repo":"my-service"}' --refresh              # 강제 재인덱싱
```

| 입력 | 설명 |
|---|---|
| `repo` (필수) | 설정에 등록된 저장소 이름 |
| `include` | 경로 접두어 필터. 멀티모듈에서 일부만 인덱싱 |
| `maxFiles` | 기본 5000 |
| `listEndpoints` | 엔드포인트 목록을 결과에 포함 |

## 출력

```jsonc
{
  "commitSha": "a3f1c9d…",
  "indexPath": "~/.devkit/index/my-service.db",
  "counts": { "files": 412, "types": 380, "methods": 2140, "endpoints": 57, "calls": 9803, "gaps": 12 },
  "languages": { "kotlin": 380, "typescript": 32 },
  "topGaps": [ { "reason": "type-body-absent", "count": 9 } ]
}
```

인덱스는 **저장소별 SQLite 파일**(`~/.devkit/index/<repo>.db`)이다.
런타임 DB(ledger/lease/cache)와 파일이 분리돼 있어, 인덱스가 커지거나 깨져도 실행 기록에 영향이 없다.
언제든 지우고 다시 만들 수 있는 파생물이다.

## 무엇을 읽는가

| 대상 | 내용 |
|---|---|
| 타입 | class / interface / object / enum, 어노테이션, 상위타입 |
| DI 필드 | 생성자 파라미터·필드의 **선언 타입** — 호출 수신자 해석의 유일한 근거 |
| 메서드 | 이름, 라인, 어노테이션(`@Transactional` 등), 본문 내 호출 |
| 엔드포인트 | Spring(`@RestController` + `@*Mapping`, `@KafkaListener`, `@Scheduled`, `@EventListener`), Next.js(`app/**/route.ts`) |

## 정확도 한계 (ADR-002 1단계)

**어휘 스캐너 기반이고 타입 추론이 없다.** 주석·문자열을 제거한 뒤 선언 구조를 읽는 방식이다.

읽지 못한 구간은 버리지 않고 `gaps`로 남기며, 그 비율만큼 `confidence`를 낮춘다.

| gap | 뜻 |
|---|---|
| `type-body-absent` | 본문 없는 선언(마커 인터페이스·`@Entity`). 타입은 인덱싱되지만 멤버는 없음 |
| `type-body-not-found` | 중괄호 짝을 못 찾음. 멤버가 인덱스에 없음 |
| `no-type-parsed` | 타입 선언이 있는데 하나도 못 읽음 — 문법이 스캐너 범위 밖 |
| `read-failed` | 파일 읽기 실패(바이너리·인코딩·권한) |

보이지 않는 것: 리플렉션, 동적 프록시, AOP, 제네릭 타입 인자로만 결정되는 대상.

> 정확도가 목표(수동 조사 대비 90%)에 못 미치면 `plan.md` **ADR-004**에 따라
> Kotlin Analysis API 기반 JVM 사이드카로 승급한다. 툴 계약이 프로세스 경계라
> 이 파일만 교체하면 된다.

## 테스트

```bash
dk test repo-map
node --test packages/lang/test/scan.test.ts        # 스캐너 회귀 테스트
node --test tools/trace-flow/test/pipeline.test.ts # repo-map → trace-flow 통합
```
