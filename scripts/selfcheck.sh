#!/bin/sh
# devkit 셀프체크 — M0 플랫폼이 설계대로 동작하는지 end-to-end로 확인한다.
#
# npm test가 단위/통합 레벨을 본다면, 이 스크립트는 "실제 CLI/MCP를 밖에서 두드렸을 때"를 본다.
# 격리된 DEVKIT_HOME을 쓰므로 개인 ~/.devkit 데이터를 건드리지 않는다.
#
# 사용: ./scripts/selfcheck.sh

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DK="$ROOT/bin/dk"
export DEVKIT_HOME="${TMPDIR:-/tmp}/devkit-selfcheck-$$"
trap 'rm -rf "$DEVKIT_HOME"' EXIT

PASS=0
FAIL=0

ok()   { PASS=$((PASS+1)); printf '  ✓ %s\n' "$1"; }
no()   { FAIL=$((FAIL+1)); printf '  ✗ %s\n     기대: %s\n     실제: %s\n' "$1" "$2" "$3"; }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# JSON에서 키 값을 뽑는다 (node 사용 — jq 없어도 동작)
jget() { node -e '
  let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    try { const v=process.argv[1].split(".").reduce((o,k)=>o?.[k], JSON.parse(s));
          console.log(v===undefined?"":String(v)); } catch { console.log("PARSE_ERROR"); }
  })' "$1"; }

# ── 1. 환경 진단 ────────────────────────────────────────────────
head "1. 환경 진단 — dk doctor"
if "$DK" doctor >/dev/null 2>&1; then
  ok "doctor 전체 통과"
else
  # 저장소 미등록은 정상(아직 분석 툴이 없다). Node/SQLite 실패만 문제로 본다.
  if "$DK" doctor 2>/dev/null | grep -q '✗ Node'; then
    no "Node 런타임" "Node >= 24" "$("$DK" doctor 2>/dev/null | grep 'Node')"
  else
    ok "doctor — 핵심 항목 통과 (저장소 미등록은 M1 전까지 정상)"
  fi
fi

# ── 2. 계약이 실제로 강제되는가 ─────────────────────────────────
head "2. 툴 계약 강제 — 잘못된 입력은 실행 전에 막힌다"

CODE=$("$DK" run echo --input '{"msg":"오타"}' 2>&1 >/dev/null | jget error.code)
[ "$CODE" = "INPUT_INVALID" ] \
  && ok "오타 난 입력 → INPUT_INVALID" \
  || no "오타 난 입력" "INPUT_INVALID" "$CODE"

HINT=$("$DK" run echo --input '{"msg":"오타"}' 2>&1 >/dev/null | jget error.hint)
[ -n "$HINT" ] \
  && ok "에러에 hint가 붙는다: $HINT" \
  || no "에러 hint" "비어있지 않음" "(없음)"

CODE=$("$DK" run 없는툴 --input '{}' 2>&1 >/dev/null | jget error.code)
[ "$CODE" = "TOOL_NOT_FOUND" ] \
  && ok "없는 툴 → TOOL_NOT_FOUND" \
  || no "없는 툴" "TOOL_NOT_FOUND" "$CODE"

# ── 3. evidence 강제 (설계원칙 P3) ──────────────────────────────
head "3. evidence 강제 — 근거 없는 결과는 반환되지 않는다"

EV=$("$DK" run echo --input '{"message":"x"}' 2>/dev/null | jget evidence.0.kind)
[ -n "$EV" ] \
  && ok "정상 툴은 evidence를 반환한다 (kind=$EV)" \
  || no "evidence 반환" "kind 존재" "(없음)"
printf '     (evidence 누락 시 EVIDENCE_REQUIRED로 막히는지는 npm test가 검증)\n'

# ── 4. 캐시 (설계원칙 P6) ───────────────────────────────────────
head "4. 결정적 툴 캐시"

"$DK" run echo --input '{"message":"cache-me"}' >/dev/null 2>&1
HIT=$("$DK" run echo --input '{"message":"cache-me"}' 2>/dev/null | jget timings.cacheHit)
[ "$HIT" = "true" ] \
  && ok "2회차 호출은 캐시 적중" \
  || no "캐시 적중" "true" "$HIT"

HIT=$("$DK" run echo --input '{"message":"cache-me"}' --refresh 2>/dev/null | jget timings.cacheHit)
[ "$HIT" = "false" ] \
  && ok "--refresh는 캐시를 무시한다" \
  || no "--refresh" "false" "$HIT"

# ── 5. 드라이런 ─────────────────────────────────────────────────
head "5. --explain — 실행 없이 계획만"

EFF=$("$DK" run echo --input '{"message":"x"}' --explain 2>/dev/null | jget policy.effect)
DATA=$("$DK" run echo --input '{"message":"x"}' --explain 2>/dev/null | jget data)
[ "$EFF" = "allow" ] && [ -z "$DATA" ] \
  && ok "정책 결정만 돌려주고 실행하지 않는다" \
  || no "--explain" "policy.effect=allow, data 없음" "effect=$EFF data=$DATA"

# ── 6. 관측성이 정직한가 ────────────────────────────────────────
head "6. 관측성 — 실패도 기록되는가"

RUNS=$("$DK" runs --since 1h --json 2>/dev/null)
HAS_FAIL=$(printf '%s' "$RUNS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const r=JSON.parse(s); console.log(r.some(x=>x.error_code==="INPUT_INVALID")?"yes":"no")})')
[ "$HAS_FAIL" = "yes" ] \
  && ok "INPUT_INVALID가 ledger에 남았다" \
  || no "실패 기록" "yes" "$HAS_FAIL"

RATE=$("$DK" run devkit-observe --input '{"view":"stats","sinceHours":1,"tool":"echo"}' 2>/dev/null \
        | jget data.stats.0.successRate)
case "$RATE" in
  1|"") no "성공률" "1 미만 (실패가 반영되어야 함)" "$RATE" ;;
  *)    ok "echo 성공률이 실패를 반영한다: $RATE" ;;
esac

LOG="$DEVKIT_HOME/runs/$(date +%Y-%m-%d).jsonl"
[ -s "$LOG" ] \
  && ok "JSONL 감사 로그 기록됨 ($(wc -l < "$LOG" | tr -d ' ')줄)" \
  || no "JSONL 로그" "$LOG 존재" "(없음)"

# ── 7. 동시성 (요구사항 3) ──────────────────────────────────────
head "7. 동시성 — 에이전트 8개 동시 실행"

TMP="$DEVKIT_HOME/conc"; mkdir -p "$TMP"
i=1
while [ $i -le 8 ]; do
  "$DK" run echo --input "{\"message\":\"agent$i\",\"delayMs\":150}" \
        --agent "A$i" --refresh --compact > "$TMP/out$i.json" 2>/dev/null &
  i=$((i+1))
done
wait

OKC=$(grep -l '"ok":true' "$TMP"/out*.json 2>/dev/null | wc -l | tr -d ' ')
[ "$OKC" = "8" ] \
  && ok "8개 병렬 실행 전부 성공" \
  || no "병렬 실행" "8" "$OKC"

AGENTS=$("$DK" runs --since 1h --json 2>/dev/null | node -e 'let s="";
  process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);
  console.log(new Set(r.filter(x=>x.agent_id.startsWith("A")).map(x=>x.agent_id)).size)})')
[ "$AGENTS" = "8" ] \
  && ok "8개 에이전트가 모두 ledger에 구분 기록됨" \
  || no "ledger 무결성" "8" "$AGENTS"

# ── 8. MCP surface ──────────────────────────────────────────────
head "8. MCP — Claude Code가 붙는 그 경로"

MCPOUT=$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"message":"mcp"},"_meta":{"agentId":"selfcheck"}}}' \
  | node --disable-warning=ExperimentalWarning "$ROOT/apps/mcp/src/stdio.ts" 2>/dev/null)

RESULT=$(printf '%s' "$MCPOUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  const out={};
  for (const l of s.trim().split("\n")) { const m=JSON.parse(l);
    if(m.id===1) out.server=m.result?.serverInfo?.name;
    if(m.id===2) out.tools=m.result?.tools?.length;
    if(m.id===3) out.callOk=m.result?.isError===false; }
  console.log(JSON.stringify(out))})')

printf '%s' "$RESULT" | grep -q '"server":"devkit"' \
  && ok "initialize 응답" || no "initialize" "server=devkit" "$RESULT"
EXPECTED=$("$DK" list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).length))')
printf '%s' "$RESULT" | grep -q "\"tools\":$EXPECTED" \
  && ok "tools/list — 툴 ${EXPECTED}개 노출 (dk list와 일치)" || no "tools/list" "$EXPECTED" "$RESULT"
printf '%s' "$RESULT" | grep -q '"callOk":true' \
  && ok "tools/call 성공" || no "tools/call" "isError=false" "$RESULT"

# ── 9. 골든 + 계약 테스트 ───────────────────────────────────────
head "9. dk test — 골든 픽스처 + 계약 테스트"

TESTOUT=$("$DK" test 2>&1 | tail -1)
printf '%s' "$TESTOUT" | grep -q '실패' \
  && no "dk test" "전체 통과" "$TESTOUT" \
  || ok "dk test — $TESTOUT"

# ── 결과 ────────────────────────────────────────────────────────
printf '\n\033[1m결과: %d 통과 / %d 실패\033[0m\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
