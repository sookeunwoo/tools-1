# M0 직접 써보기

M0에는 아직 코드 분석 툴이 없다. 지금 확인할 수 있는 건 **플랫폼 자체**다 —
계약이 실제로 강제되는지, 관측성이 정직한지, 동시성이 진짜인지, MCP로 붙는지.

```bash
cd ~/IdeaProjects/devkit
```

`bin/dk`는 어느 디렉토리에서 실행해도 자기 저장소를 찾는다. PATH에 넣어두면 편하다:

```bash
export PATH="$HOME/IdeaProjects/devkit/bin:$PATH"   # ~/.zshrc 에 추가
```

---

## 0. 한 번에 다 확인하기

```bash
./scripts/selfcheck.sh      # 9개 시나리오 17개 검증, 격리된 임시 DEVKIT_HOME 사용
npm test                    # 단위/통합 22개
```

셀프체크는 개인 `~/.devkit` 데이터를 건드리지 않는다.
아래는 **무엇을 왜 확인하는지** 이해하려고 손으로 해보는 순서다.

---

## 1. 살아있는지

```bash
dk doctor      # 환경 진단 — 문제마다 고치는 명령이 붙는다
dk list        # 등록된 툴
dk describe echo
```

`dk doctor`에서 **"등록된 저장소 없음"은 지금 정상이다.** 저장소를 읽는 툴이 M1부터 생긴다.

`dk describe`가 보여주는 게 곧 **툴 계약**이다. 에이전트는 이 정보만 보고 툴을 고른다:

```
echo v0.1.0
언제 쓰는가:
  devkit 자체가 정상 동작하는지 확인할 때. ...
부수효과: read | 동시성: safe
결정성: pure | 타임아웃: 65s | 승인필요: false
```

## 2. 툴 실행

```bash
dk run echo --input '{"message":"hello","repeat":2}'
```

```jsonc
{
  "ok": true,
  "runId": "...",
  "confidence": 1,
  "data": { "echoed": ["1: hello", "2: hello"], "count": 2 },
  "evidence": [ { "kind": "command", "command": "echo(\"hello\")", "exitCode": 0 } ],
  "timings": { "totalMs": 10, "cacheHit": false }
}
```

`--input`은 세 가지를 받는다: 인라인 JSON, `@파일.json`, `-`(stdin).

## 3. 계약이 진짜로 강제되는가 ★

**여기가 devkit의 핵심이다.** 오타를 내보자:

```bash
dk run echo --input '{"msg":"오타"}'
```

```jsonc
{ "ok": false, "error": {
  "code": "INPUT_INVALID",
  "message": "입력이 'echo' 계약과 맞지 않습니다 — $.message: 필수 항목이 누락되었습니다;
              $.msg: 알 수 없는 항목입니다. 허용: message, repeat, delayMs",
  "hint": "dk describe echo 로 입력 스키마를 확인하세요.",
  "retryable": false }}
```

**툴이 실행되기 전에** 막혔고, 뭐가 틀렸는지와 어떻게 확인하는지가 같이 왔다.
에이전트가 이 응답만 보고 스스로 고칠 수 있다.

없는 툴도 마찬가지:

```bash
dk run 없는툴 --input '{}'    # → TOOL_NOT_FOUND + 사용 가능한 툴 목록
```

## 4. 실행 없이 계획만 보기 (`--explain`)

```bash
dk run echo --input '{"message":"x"}' --explain
```

```jsonc
{
  "resolvedInput": { "message": "x", "repeat": 1, "delayMs": 0 },   // default가 채워짐
  "policy": { "effect": "allow", "reasons": ["allow/deny 통과", "사내 보안 훅: noop (M5 예정)"] },
  "leasePlan": [],
  "cache": { "eligible": true, "key": "d61872...", "hit": false, "reason": "캐시 사용 가능" },
  "timeoutSec": 65
}
```

**툴 디버깅의 1단계다.** 여기서 이미 이상하면 코드가 아니라 설정/정책 문제다.

## 5. 캐시

```bash
dk run echo --input '{"message":"cache-me"}'   # cacheHit: false
dk run echo --input '{"message":"cache-me"}'   # cacheHit: true   ← 재실행 안 함
dk run echo --input '{"message":"cache-me"}' --refresh   # false  ← 강제 재실행
```

> 툴을 수정하면서 테스트할 때는 **항상 `--refresh`**를 붙여라. 안 붙이면 고친 코드가 안 돈다.

## 6. 관측성 — 사람이 보는 화면

```bash
dk runs --since 1h     # 실행 이력
dk stats --since 1h    # 툴별 성공률/p50/p95/캐시/신뢰도
dk ps                  # 실행 중인 툴 + 점유 자원
dk tail                # 감사 로그 원본 (JSONL)
dk tail -f             # 실시간
```

`dk stats`가 **실패를 반영하는지** 확인해보자:

```bash
dk run echo --input '{"bad":1}' 2>/dev/null   # 일부러 실패
dk stats --since 1h
```

```
툴                  호출     성공률      p50      p95      캐시      신뢰도
echo               3      67%      2ms      5ms      33%     1.00
```

> 도그푸딩 첫날 여기서 버그가 나왔다. 원래 `INPUT_INVALID`가 ledger에 안 남아서
> 성공률이 100%로 보였다. **에이전트가 가장 자주 겪는 실패가 안 보이면 개선점을 못 찾는다.**

감사 로그 원본은 `~/.devkit/runs/YYYY-MM-DD.jsonl`이다. `jq`로 바로 읽힌다:

```bash
jq -c 'select(.event=="run.end") | {tool, status, durationMs}' ~/.devkit/runs/*.jsonl
```

## 7. 관측성 — 에이전트가 보는 화면

```bash
dk run devkit-observe --input '{"view":"summary","sinceHours":1}'
dk run devkit-observe --input '{"view":"failures"}'
dk run devkit-observe --input '{"view":"leases"}'    # 다른 에이전트가 뭘 점유 중인지
```

`notes` 필드를 보면 툴이 **스스로 개선점을 지적한다**:

```
"notes": ["최근 1시간 미사용 툴: devkit-observe (P10: 30일 미사용이면 삭제 대상)"]
```

## 8. 동시성 — 에이전트 8개 동시 실행 ★

```bash
for i in $(seq 1 8); do
  dk run echo --input "{\"message\":\"agent$i\",\"delayMs\":200}" \
     --agent "A$i" --refresh --compact &
done; wait

dk runs --since 1m      # 8개가 각자 agent_id로 구분되어 남았는지
```

배타 자원 경합도 볼 수 있다 (별도 프로세스 8개가 같은 락을 노림):

```bash
node --disable-warning=ExperimentalWarning --test packages/core/test/lease.test.ts
```

→ `✔ 같은 자원에 대해 한 프로세스만 성공한다`

## 9. MCP로 Claude Code에 붙이기 ★★

**이게 실제 사용 경로다.**

```bash
claude mcp add devkit -- ~/IdeaProjects/devkit/bin/dk mcp
```

새 Claude Code 세션에서 `/mcp`로 연결을 확인하고, 이렇게 물어보면 된다:

> devkit-observe로 최근 1시간 툴 사용 현황 보여줘

수동으로 프로토콜을 두드려보려면:

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"message":"mcp"}}}' \
| node --disable-warning=ExperimentalWarning packages/mcp/src/stdio.ts
```

제거는 `claude mcp remove devkit`.

## 10. 에이전트가 툴을 고칠 수 있는가 ★ (제약 2 검증)

일부러 계약 위반 버그를 심어본다:

```bash
cp tools/echo/index.ts /tmp/echo.bak
perl -pi -e 's/count: echoed\.length/count: String(echoed.length)/' tools/echo/index.ts

dk run echo --input '{"message":"x"}'
```

```jsonc
{ "ok": false, "error": {
  "code": "OUTPUT_CONTRACT_VIOLATION",
  "message": "출력이 outputSchema와 맞지 않습니다 — $.count: 타입이 integer 이어야 합니다 (받은 값: string)",
  "hint": "index.ts의 반환값 또는 manifest.json의 outputSchema 중 하나가 틀렸습니다.",
  "source": { "file": "tools/echo/index.ts", "line": 1 } }}
```

```bash
dk test echo        # 골든 픽스처 2건이 같은 이유로 실패
cp /tmp/echo.bak tools/echo/index.ts
dk test echo        # 7/7 통과
```

**빌드 단계가 없어서** 파일을 되돌리는 순간 바로 반영된다. 이게 P7(네이티브 의존성 0)의 실질적 효용이다.

## 11. 새 툴 만들어보기

```bash
dk scaffold tool my-analyzer --summary "테스트용"
dk test my-analyzer
```

생성 직후엔 **일부러 실패한다** — `manifest.json`의 `whenToUse`와 픽스처에 `TODO`가 박혀 있고,
그게 뭘 채워야 하는지 알려준다. 계약을 지킨 상태로 시작하게 하려는 의도다.

```bash
rm -rf tools/my-analyzer     # 정리
```

수정 절차 전체는 `AGENTS.md`에 6단계로 정리되어 있다.

---

## 지금은 안 되는 것 (M1 이후)

| 하고 싶은 것 | 언제 |
|---|---|
| 코드 흐름 추적 (`trace-flow`) | M1 |
| 티켓 브리핑 생성 (`context-pack`) | M1 |
| 변경 영향 반경 (`impact-scan`) | M2 |
| 변경분 커버리지 (`coverage-diff`) | M3 |
| Jira / DB 접근 | M5 — **사내 보안 정책 확인 후** |

저장소 등록은 미리 해둘 수 있다 (`dk doctor`가 확인해준다):

```bash
dk init          # ~/.devkit/config.toml 생성
```

```toml
[repos.my-service]
path = "~/IdeaProjects/my-service"
lang = ["kotlin"]
framework = ["spring-boot"]
entrypoint_globs = ["**/*Controller.kt", "**/*Listener.kt"]
```
