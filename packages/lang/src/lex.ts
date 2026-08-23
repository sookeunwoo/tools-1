/**
 * 어휘 전처리 — 주석과 문자열을 지운다.
 *
 * 정규식으로 코드를 훑기 전에 **주석·문자열 안의 내용을 공백으로 치환**한다.
 * 오프셋과 줄바꿈은 그대로 두므로 이후 매치 위치가 원본 라인 번호와 정확히 일치한다.
 *
 * 이 한 단계가 순진한 정규식과 갈리는 지점이다. 이게 없으면
 * 주석 안의 `// fun foo()` 나 문자열 안의 `"@Transactional"` 이 전부 심볼로 잡힌다.
 */

export type Cleaned = { text: string; original: string };

export function stripCode(src: string): Cleaned {
  const out = src.split('');
  const n = src.length;
  let i = 0;

  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && next === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      blank(i, Math.min(j + 2, n));
      i = j + 2;
      continue;
    }
    // Kotlin raw string """..."""
    if (c === '"' && next === '"' && src[i + 2] === '"') {
      let j = i + 3;
      while (j < n && !(src[j] === '"' && src[j + 1] === '"' && src[j + 2] === '"')) j++;
      blank(i, Math.min(j + 3, n));
      i = j + 3;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        if (src[j] === '\n' && c !== '`') break; // 닫히지 않은 문자열 방어
        j++;
      }
      blank(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    i++;
  }

  return { text: out.join(''), original: src };
}

/** 오프셋 → 1-기반 라인 번호. */
export function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/**
 * `from` 이후 첫 `{` 부터 짝이 맞는 `}` 까지의 범위.
 * 못 찾으면 null (본문 없는 선언 — 인터페이스 메서드, abstract 등).
 */
export function blockRange(text: string, from: number, limit = 200_000): { start: number; end: number } | null {
  let i = from;
  // 선언과 본문 사이에 나올 수 있는 것만 건너뛴다. `;`나 다음 선언을 만나면 본문이 없는 것.
  while (i < text.length && i < from + 400) {
    const c = text[i];
    if (c === '{') break;
    if (c === ';' || c === '}') return null;
    i++;
  }
  if (i >= text.length || text[i] !== '{') return null;

  const start = i;
  let depth = 0;
  for (let j = i; j < text.length && j < i + limit; j++) {
    if (text[j] === '{') depth++;
    else if (text[j] === '}') {
      depth--;
      if (depth === 0) return { start, end: j + 1 };
    }
  }
  return null; // 짝이 안 맞음 — 호출자가 gap으로 기록한다
}

/**
 * 선언 앞에 붙은 어노테이션 수집.
 *
 * 위치 탐색은 clean(주석·문자열 제거본)에서 하고, **인자 문자열은 original에서 읽는다.**
 * clean에는 `@PostMapping("/v1/orders")`의 경로가 공백으로 지워져 있기 때문이다.
 */
export function annotationsBefore(
  c: Cleaned,
  declStart: number,
): Array<{ name: string; args?: string }> {
  const from = Math.max(0, declStart - 600);
  const slice = c.text.slice(from, declStart);

  // 앞 선언의 어노테이션을 훔치지 않도록 경계를 찾는다.
  // 중괄호·세미콜론뿐 아니라 **앞선 선언 키워드**도 경계다 —
  // `class Order`(본문 없음) 처럼 중괄호가 없으면 @Entity가 다음 타입으로 샌다(도그푸딩에서 발견).
  let cut = Math.max(slice.lastIndexOf('}'), slice.lastIndexOf('{'), slice.lastIndexOf(';'));
  for (const m of slice.matchAll(/\b(?:class|interface|object|enum|fun)\s+\w+/g)) {
    cut = Math.max(cut, m.index! + m[0].length - 1);
  }
  const base = from + (cut === -1 ? 0 : cut + 1);
  const region = c.text.slice(base, declStart);

  const found: Array<{ name: string; args?: string }> = [];
  const re = /@([A-Z][\w.]*)\s*(\(([^()]*(?:\([^()]*\)[^()]*)*)\))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(region))) {
    const args = m[2] ? c.original.slice(base + m.index + m[0].indexOf('('), base + m.index + m[0].length) : undefined;
    found.push({ name: m[1], args: args?.slice(1, -1).trim() });
  }
  return found;
}

/** 어노테이션 인자에서 첫 문자열 리터럴을 꺼낸다. `@GetMapping("/x")` → `/x` */
export function annotationArg(ann: { args?: string } | undefined): string | null {
  if (!ann?.args) return null;
  const m = ann.args.match(/["']([^"']*)["']/);
  return m ? m[1] : null;
}
