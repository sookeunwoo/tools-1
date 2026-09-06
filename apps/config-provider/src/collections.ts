/**
 * 컬렉션 — 키를 논리적으로 묶는 사용자 정리 단위 (UI 좌측 패널).
 *
 * 왜 항목(Item)에 필드를 달지 않고 별도 파일로 두는가:
 *   1) secret 항목을 다른 묶음으로 옮기는 데 age 개인키가 필요해진다. 컬렉션은 값이 아니라
 *      정리 정보인데, 축소 모드에서 정리조차 못 하게 되는 건 과한 대가다.
 *   2) public.yaml/secret.yaml은 스키마가 엄격하고(알 수 없는 필드 = 파싱 실패) git으로
 *      공유되는 파일이다. 화면 정리 정보가 그 계약에 섞이면 두 관심사가 같이 흔들린다.
 *
 * 그래서 `collections.yaml`은 "key 이름의 집합"만 담는다. 값도, 메타데이터도 없다.
 * 어떤 컬렉션에도 없는 key는 '미분류'다 — 저장하지 않고 조회 시점에 계산한다.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DevkitError } from '#core/errors.ts';
import { collectionsPath } from './paths.ts';
import { parse, stringify, type YamlNode } from './yaml.ts';

export type Collection = { name: string; keys: string[] };

const HEADER = [
  '# collections.yaml — 키를 묶는 사용자 정리 단위 (UI 좌측 패널)',
  '# 값은 들어있지 않다. key 이름만 담으므로 그대로 git에 커밋해도 된다.',
  '# 어떤 컬렉션에도 없는 key는 UI에서 "미분류"로 보인다.',
].join('\n');

/** 파일이 없으면 빈 목록이다 — 컬렉션을 한 번도 안 만든 저장소가 정상 상태다. */
export function loadCollections(): Collection[] {
  const path = collectionsPath();
  if (!existsSync(path)) return [];

  let doc: YamlNode;
  try {
    doc = parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DevkitError({
      code: 'COLLECTIONS_PARSE_FAILED',
      message: `collections.yaml 파싱 실패 — ${(err as Error).message}`,
      hint: '형식은 `collections: [{ name, keys }]`입니다. 파일을 열어 해당 행을 확인하세요.',
      retryable: false,
    });
  }
  if (doc === null) return [];
  const raw = (doc as Record<string, YamlNode>)?.collections;
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw invalid('collections는 시퀀스여야 합니다');

  return raw.map((node, i) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      throw invalid(`collections[${i}]는 맵이어야 합니다`);
    }
    const o = node as Record<string, YamlNode>;
    if (typeof o.name !== 'string' || o.name.trim() === '') throw invalid(`collections[${i}].name이 없습니다`);
    const keys = o.keys ?? [];
    if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')) {
      throw invalid(`${o.name}.keys는 문자열 시퀀스여야 합니다`);
    }
    return { name: o.name.trim(), keys: [...new Set(keys as string[])] };
  });
}

export function saveCollections(list: Collection[]): void {
  const nodes = list.map((c) => ({ name: c.name, keys: c.keys }));
  const path = collectionsPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, `${HEADER}\n${stringify({ collections: nodes })}\n`, { mode: 0o644 });
  renameSync(tmp, path);
}

/**
 * 저장된 목록을 현재 항목과 맞춘다.
 *
 * 파일을 손으로 고쳐 key를 지웠을 수 있다. 없는 key를 그대로 들고 있으면 UI에 유령 행이
 * 생기므로 조회 시점에 떨어뜨린다 — 파일은 다음 쓰기에서 정리된다.
 */
export function reconcile(list: Collection[], existing: ReadonlySet<string>): Collection[] {
  const seen = new Set<string>();
  return list.map((c) => ({
    name: c.name,
    keys: c.keys.filter((k) => {
      if (!existing.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    }),
  }));
}

/** 어떤 컬렉션에도 속하지 않은 key. 저장하지 않고 매번 계산한다. */
export function uncategorized(list: Collection[], allKeys: readonly string[]): string[] {
  const taken = new Set(list.flatMap((c) => c.keys));
  return allKeys.filter((k) => !taken.has(k));
}

export function findCollection(list: Collection[], name: string): Collection | undefined {
  return list.find((c) => c.name === name);
}

export function requireCollection(list: Collection[], name: string): Collection {
  const found = findCollection(list, name);
  if (!found) {
    throw new DevkitError({
      code: 'COLLECTION_NOT_FOUND',
      message: `컬렉션 \`${name}\`이 없습니다`,
      hint: 'GET /collections로 현재 목록을 확인하세요.',
      retryable: false,
    });
  }
  return found;
}

export function assertNameFree(list: Collection[], name: string): void {
  if (findCollection(list, name)) {
    throw new DevkitError({
      code: 'COLLECTION_EXISTS',
      message: `컬렉션 \`${name}\`이 이미 있습니다`,
      hint: '이름은 유일해야 합니다. 다른 이름을 쓰거나 기존 컬렉션으로 옮기세요.',
      retryable: false,
    });
  }
}

export function normalizeName(v: unknown): string {
  if (typeof v !== 'string' || v.trim() === '') {
    throw invalid('컬렉션 이름은 비어있지 않은 문자열이어야 합니다');
  }
  const name = v.trim();
  if (name.length > 60) throw invalid('컬렉션 이름은 60자를 넘을 수 없습니다');
  return name;
}

/** key를 한 컬렉션으로 옮긴다. 컬렉션 간 이동은 "빼고 넣기"가 아니라 이 한 연산이다. */
export function moveKey(list: Collection[], name: string, key: string): Collection[] {
  requireCollection(list, name);
  return list.map((c) => {
    if (c.name === name) return { ...c, keys: c.keys.includes(key) ? c.keys : [...c.keys, key] };
    return { ...c, keys: c.keys.filter((k) => k !== key) };
  });
}

function invalid(message: string): DevkitError {
  return new DevkitError({ code: 'INPUT_INVALID', message, retryable: false });
}
