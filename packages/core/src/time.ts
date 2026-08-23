/**
 * 시간 표기 — 감사 로그는 사람이 읽는다.
 *
 * JSONL 일별 로테이션과 타임스탬프를 모두 **로컬 시간** 기준으로 맞춘다.
 * UTC를 쓰면 자정 전후로 "오늘 로그"가 어제 파일에 들어가서, KST(+09:00)에서는
 * 매일 09:00 이전에 기록된 것이 전날 파일로 가버린다.
 * (셀프체크가 00:01 KST에 이 문제를 잡았다 — 파일명 2026-08-23 vs 로컬 2026-08-24)
 *
 * 타임스탬프에는 오프셋을 붙여 기계 처리 시에도 모호하지 않게 한다.
 */

/** 로컬 기준 YYYY-MM-DD. JSONL 파일명에 쓴다. */
export function localDate(d = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 오프셋이 붙은 ISO 8601. 예: 2026-08-24T00:01:14.123+09:00 */
export function localISO(d = new Date()): string {
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  const pad = (n: number) => String(n).padStart(2, '0');
  const shifted = new Date(d.getTime() + offsetMin * 60_000);
  return `${shifted.toISOString().slice(0, -1)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
