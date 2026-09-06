# Raycast — Config Provider

Raycast에서 `config`를 치고 검색어를 넣으면 관련 키 목록이 뜨고, 고르면 값이 클립보드에 담긴다.

```
⌘Space → config 결제
  🔒 PAYMENT_API_KEY   결제 API 키 · PG 키 — 결제 승인·환불에 쓰는 라이브 키   api_key  prod · dev
  ↵ dev 값 복사    ⌘⇧V 붙여넣기    ⌘⏎ 다른 env    ⌘⇧C key 이름    ⌘O UI 열기
```

## 루트 검색창에서 바로 결과를 볼 수는 없다

Raycast **루트 검색창에 확장의 결과를 실시간으로 그리는 API는 없다.** 거기서 인라인 결과를
내는 건 계산기·단위 변환 같은 내장 기능뿐이고, 확장의 뷰는 커맨드를 연 뒤에 그려진다.
(찾는 용어라면 — 치는 동안 결과가 갱신되는 방식은 일반적으로 *search-as-you-type* ·
*incremental search* · *type-ahead*라고 부른다. Raycast에서 루트에 친 텍스트를 커맨드로
넘기는 기능의 이름은 **Fallback Commands**, 커맨드 뒤에 값을 붙이는 건 **Command Arguments**다.)

대신 "Enter 한 번"을 없애거나 검색어를 이어받는 길이 셋 있다. 커맨드를 연 다음부터는
**글자마다 실시간으로 목록이 갱신된다** — 데몬이 로컬 UDS라 왕복이 사실상 공짜다.

| 방법 | 조작 | 설정 위치 |
|---|---|---|
| **핫키** (권장) | `⌥C` 한 번에 목록이 열리고 바로 타이핑 | Raycast Settings → Extensions → Config → Record Hotkey |
| **별칭** | 루트에서 `cf` → `↵` | 같은 화면의 Alias 칸 |
| **Fallback Command** | 루트에 `결제`를 먼저 친 뒤 Config 선택 → 그 텍스트가 검색어로 들어온다 | Settings → Extensions → Fallback Commands에 추가 |

`config` → `Tab` → `결제` → `↵` (Command Arguments)도 그대로 동작한다.

## 설치

이 확장은 **별도 npm 패키지**다. devkit 본체(의존성 0 · 빌드 없음)와 달리 Raycast API와
빌드 단계가 필요해서 분리해 뒀다. 본체 실행에는 영향을 주지 않는다.

```bash
cd apps/config-provider/raycast
npm install
npm run dev          # Raycast가 열리고 개발 모드로 설치된다. 한 번 실행하면 등록이 유지된다
```

Raycast Store에 올리는 확장이 아니라 로컬 전용이다 (`"private": true`). 값이 오가는
확장을 남의 인프라에 올릴 이유가 없다.

## 설정 (Raycast → Extensions → Config Provider)

| 설정 | 기본값 | 설명 |
|---|---|---|
| 기본 env | `dev` | ↵로 복사할 때 쓰는 환경. 비우면 데몬의 기본값을 따른다 |
| 데몬 소켓 경로 | (자동) | 비우면 `paths.ts`와 같은 규칙으로 찾는다 |
| dkc 실행 파일 | `dkc` | '데몬 시작' 동작에 쓴다. PATH에 없으면 전체 경로를 넣는다 |
| UI 주소 | `http://127.0.0.1:7777` | '⌘O UI 열기'가 여는 주소 |

`prod`를 기본 env로 두지 않는 게 좋다. 데몬과 CLI가 `dev`를 기본으로 두는 이유와 같다 —
prod 값은 항상 명시적으로 고르는 편이 안전하다.

## 값을 다루는 방식

- **목록에는 값이 없다.** 검색은 `/alias/search`(메타데이터 전용)를 쓰고, 값은 고른 항목
  하나에 대해 `/config/{key}?env=`로 그 순간에만 가져온다 (스펙 §4.3의 2단계 조회)
- **복사는 `concealed`로 한다.** Raycast 클립보드 기록에 비밀값이 남지 않는다
- **⌘⇧V 붙여넣기**는 클립보드를 아예 거치지 않고 앞 창에 바로 넣는다. 비밀값은 이쪽이 낫다
- 데몬에는 **소유자(owner)** 자격으로 붙는다. UI·CLI와 같은 등급이다 — 에이전트 화이트리스트
  (policy.yaml)의 적용 대상이 아니다. Raycast는 사람이 직접 쓰는 창구이기 때문이다
- 축소 모드(age 키 없음)에서는 secret 값 대신 이유가 담긴 오류가 뜬다

## 구조

| 파일 | 역할 |
|---|---|
| `src/dkc.ts` | 데몬 접근. **Raycast API에 의존하지 않는다** — devkit 테스트가 이 파일을 직접 돌린다 |
| `src/search-config.tsx` | 목록·동작 UI |

`apps/config-provider/test/raycast.test.ts`가 소켓 경로 규칙이 본체와 어긋나지 않는지,
목록 경로가 값을 실어오지 않는지를 회귀로 잡는다. Raycast를 띄우지 않고 `npm test`로 돈다.
