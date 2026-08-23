/**
 * trace-flow — 엔드포인트에서 다운스트림까지 (plan.md §13.1, 기둥 A).
 *
 * 존재 이유: "이 API가 무엇을 건드리는가"를 알아내려고 코드를 수십 번 읽는 걸 없앤다 (P11).
 *
 * 해석 전략: 타입 추론을 하지 않는다. **DI 필드의 선언 타입 + 메서드명**만으로 수신자를 정하고,
 * 인터페이스가 여러 구현체를 가지면 전부 나열하며 confidence를 낮춘다.
 * 못 푼 엣지는 숨기지 않고 unresolved로 돌려준다 (P9).
 */

import type { Evidence, ToolContext, ToolResult, Unresolved } from '#core/contract.ts';
import { DevkitError } from '#core/errors.ts';
import { openReader, type IndexReader } from '#lang/store.ts';

type Input = { repo: string; entry: string; maxDepth: number; mode: 'summary' | 'full' };
type Ann = { name: string; args?: string };

type Node = {
  id: string; typeName: string; methodName: string;
  kind: 'endpoint' | 'controller' | 'service' | 'repository' | 'external' | 'component' | 'unknown';
  path?: string; line?: number; depth: number;
  transactional?: { readOnly: boolean; propagation: string };
};
type Edge = { from: string; to: string; line: number; confidence: number; note?: string };

const WRITE_OPS = /^(save|insert|update|delete|persist|merge|remove|upsert|create)/i;
const EXTERNAL_ANN = new Set(['FeignClient', 'HttpExchange']);

export async function run(input: Input, ctx: ToolContext): Promise<ToolResult> {
  const reader = openReader(input.repo, ctx.commitSha ?? undefined);
  try {
    return trace(input, ctx, reader);
  } finally {
    reader.close();
  }
}

function trace(input: Input, ctx: ToolContext, ix: IndexReader): ToolResult {
  const evidence: Evidence[] = [];
  const unresolved: Unresolved[] = [];
  const sha = ix.meta.commitSha;

  const start = resolveEntry(ix, input.entry);
  evidence.push({ kind: 'code', path: start.path, line: start.line, sha, excerpt: start.label });

  const nodes = new Map<string, Node>();
  const edges: Edge[] = [];
  const tables = new Map<string, Set<string>>();
  const externals: Array<{ name: string; method: string; via: string; line: number }> = [];
  const events: Array<{ topic: string; direction: string; via: string }> = [];
  const risks: Array<{ severity: string; at: string; why: string; path?: string; line?: number }> = [];

  const rootId = `${start.typeName}.${start.methodName}`;
  const queue: Array<{ typeName: string; methodName: string; depth: number; inTx: null | { readOnly: boolean } }> = [
    { typeName: start.typeName, methodName: start.methodName, depth: 0, inTx: null },
  ];
  const visited = new Set<string>();
  let ambiguous = 0;
  let unresolvedEdges = 0;
  let totalEdges = 0;

  while (queue.length > 0) {
    const cur = queue.shift()!;
    const id = `${cur.typeName}.${cur.methodName}`;
    if (visited.has(id) || cur.depth > input.maxDepth) continue;
    visited.add(id);

    const type = ix.type(cur.typeName);
    const method = ix.method(cur.typeName, cur.methodName);
    const typeAnns: Ann[] = type ? JSON.parse(type.annotations) : [];
    const methodAnns: Ann[] = method ? JSON.parse(method.annotations) : [];

    const tx = readTransaction(methodAnns) ?? readTransaction(typeAnns);
    const inTx = tx && tx.propagation !== 'NOT_SUPPORTED' ? { readOnly: tx.readOnly } : cur.inTx;

    const node: Node = {
      id,
      typeName: cur.typeName,
      methodName: cur.methodName,
      kind: id === rootId ? 'endpoint' : classify(cur.typeName, typeAnns),
      path: method?.path ?? type?.path,
      line: method?.line ?? type?.line,
      depth: cur.depth,
      transactional: tx ?? undefined,
    };
    nodes.set(id, node);
    if (node.path && nodes.size <= 12) {
      evidence.push({ kind: 'code', path: node.path, line: node.line, sha, excerpt: `${node.kind} ${id}` });
    }

    if (!method) continue; // 인덱스에 본문이 없다 — 외부 라이브러리이거나 스캐너가 못 읽음

    const fields = new Map(ix.fields(cur.typeName).map((f) => [f.name, f.field_type]));
    const hasIteration = ix.calls(cur.typeName, cur.methodName).some((c) => /^(forEach|map|flatMap|filter)$/.test(c.callee));

    for (const call of ix.calls(cur.typeName, cur.methodName)) {
      totalEdges++;
      const targetType = call.receiver === null ? cur.typeName : fields.get(call.receiver);

      if (!targetType) {
        // 지역 변수·체이닝 결과 등 — 타입 추론 없이는 못 푼다. 정직하게 남긴다.
        if (call.receiver && /^[a-z]/.test(call.receiver)) unresolvedEdges++;
        continue;
      }

      const candidates = resolveCandidates(ix, targetType);
      if (candidates.length > 1) ambiguous++;

      for (const target of candidates) {
        const targetId = `${target}.${call.callee}`;
        const targetAnns: Ann[] = JSON.parse(ix.type(target)?.annotations ?? '[]');
        const kind = classify(target, targetAnns);
        const conf = candidates.length > 1 ? round(1 / candidates.length) : 1;

        edges.push({
          from: id, to: targetId, line: call.line, confidence: conf,
          note: candidates.length > 1 ? `${targetType} 구현체 ${candidates.length}개 중 하나` : undefined,
        });

        // 부수효과 태깅
        if (kind === 'repository') {
          const table = tableOf(ix, target);
          if (!tables.has(table)) tables.set(table, new Set());
          tables.get(table)!.add(opOf(call.callee));
          if (inTx?.readOnly && WRITE_OPS.test(call.callee)) {
            risks.push({ severity: 'high', at: `${id} → ${targetId}`, path: node.path, line: call.line,
                         why: 'readOnly 트랜잭션 안에서 쓰기 메서드를 호출합니다' });
          }
          if (hasIteration) {
            risks.push({ severity: 'medium', at: `${id} → ${targetId}`, path: node.path, line: call.line,
                         why: '반복 호출(forEach/map) 구간에서 리포지토리를 호출합니다 — N+1 의심' });
          }
        }

        if (kind === 'external') {
          externals.push({ name: target, method: call.callee, via: id, line: call.line });
          if (inTx) {
            risks.push({ severity: 'high', at: `${id} → ${targetId}`, path: node.path, line: call.line,
                         why: '트랜잭션 경계 안에서 외부 시스템을 호출합니다 — 커넥션 점유 + 롤백 시 보상 없음' });
          }
          const retry = targetAnns.some((a) => /Retry/i.test(a.name));
          if (!retry) {
            risks.push({ severity: 'low', at: `${id} → ${targetId}`, path: node.path, line: call.line,
                         why: '외부 호출에 재시도 설정이 보이지 않습니다' });
          }
        }

        if (/^(send|publish)/.test(call.callee) && /(Template|Publisher|Producer)$/.test(target)) {
          events.push({ topic: `${target}.${call.callee}`, direction: 'publish', via: id });
        }

        if (ix.type(target)) {
          queue.push({ typeName: target, methodName: call.callee, depth: cur.depth + 1, inTx });
        } else if (!nodes.has(targetId)) {
          // 인덱스에 없는 타입(외부 라이브러리 등)도 잎 노드로 남긴다.
          // 안 그러면 edge가 존재하지 않는 노드를 가리켜 그래프가 깨진다.
          nodes.set(targetId, {
            id: targetId, typeName: target, methodName: call.callee,
            kind, depth: cur.depth + 1,
          });
        }
      }
    }
  }

  // 멱등성 키 없는 쓰기 엔드포인트
  if (start.kind === 'http' && /^(POST|PUT|PATCH)/.test(start.label)) {
    const writes = [...tables.values()].some((ops) => ops.has('write'));
    const hasKey = /idempotenc|requestId|request_id/i.test(JSON.stringify(ix.method(start.typeName, start.methodName) ?? {}));
    if (writes && !hasKey) {
      risks.push({ severity: 'medium', at: start.label, path: start.path, line: start.line,
                   why: '쓰기 엔드포인트인데 멱등성 키가 보이지 않습니다 — 재시도 시 중복 처리 가능' });
    }
  }

  // ── 정직한 한계 보고 ────────────────────────────────────────
  if (unresolvedEdges > 0) {
    unresolved.push({
      reason: 'receiver-unresolved',
      at: `${unresolvedEdges}건`,
      hint: '지역 변수·메서드 체이닝의 수신자는 타입 추론 없이 못 풉니다. 해당 라인은 직접 확인하세요.',
    });
  }
  if (ambiguous > 0) {
    unresolved.push({
      reason: 'multiple-implementations',
      at: `${ambiguous}건`,
      hint: '인터페이스에 구현체가 여럿이라 분기했습니다. 실제 주입 대상은 설정을 확인해야 합니다.',
    });
  }
  unresolved.push({
    reason: 'scanner-tier-1',
    at: 'ADR-002',
    hint: '어휘 스캐너 기반입니다. 리플렉션·동적 프록시·AOP는 보이지 않습니다.',
  });

  const resolvedRatio = totalEdges > 0 ? (totalEdges - unresolvedEdges) / totalEdges : 1;
  const confidence = round(Math.max(0.3, resolvedRatio - (ambiguous > 0 ? 0.1 : 0)));

  ctx.log('추적 완료', { nodes: nodes.size, edges: edges.length, risks: risks.length });

  const nodeList = [...nodes.values()].sort((a, b) => a.depth - b.depth);
  return {
    data: {
      entry: { key: start.label, kind: start.kind, path: start.path, line: start.line },
      nodes: input.mode === 'full' ? nodeList : nodeList.map(({ id, kind, depth, transactional, path, line }) => ({ id, kind, depth, transactional, path, line })),
      edges: input.mode === 'full' ? edges : edges.filter((e) => e.confidence < 1 || nodes.has(e.to)),
      tables: [...tables.entries()].map(([name, ops]) => ({ name, ops: [...ops] })),
      externals,
      events,
      riskPoints: dedupeRisks(risks),
    },
    evidence,
    unresolved,
    confidence,
  };
}

// ── 진입점 해석 ──────────────────────────────────────────────────

function resolveEntry(ix: IndexReader, entry: string) {
  const hits = ix.findEndpoint(entry);
  if (hits.length > 0) {
    const h = hits[0];
    return { typeName: h.type_name, methodName: h.method_name, path: h.path, line: h.line, label: h.key, kind: h.kind };
  }

  const m = entry.match(/^(\w+)[.#](\w+)$/);
  if (m) {
    const method = ix.method(m[1], m[2]);
    if (method) return { typeName: m[1], methodName: m[2], path: method.path, line: method.line, label: entry, kind: 'method' };
  }

  const available = ix.endpoints().slice(0, 15).map((e) => e.key);
  throw new DevkitError({
    code: 'ENTRY_NOT_FOUND',
    message: `진입점을 찾지 못했습니다: ${entry}`,
    hint: available.length
      ? `사용 가능한 엔드포인트(일부): ${available.join(', ')}. 또는 "Type.method" 형식을 쓰세요.`
      : '인덱스에 엔드포인트가 없습니다. repo-map을 먼저 실행했는지, include 필터가 너무 좁지 않은지 확인하세요.',
    retryable: false,
    fixCommand: `dk run repo-map --input '{"repo":"<repo>","listEndpoints":true}'`,
  });
}

// ── 분류·태깅 ────────────────────────────────────────────────────

function classify(typeName: string, anns: Ann[]): Node['kind'] {
  const has = (n: string) => anns.some((a) => a.name === n);
  if (has('RestController') || has('Controller')) return 'controller';
  if (anns.some((a) => EXTERNAL_ANN.has(a.name)) || /(Client|Gateway|Adapter)$/.test(typeName)) return 'external';
  if (has('Repository') || /(Repository|Dao|Mapper)$/.test(typeName)) return 'repository';
  if (has('Service') || /Service$/.test(typeName)) return 'service';
  if (has('Component') || has('Configuration')) return 'component';
  return 'unknown';
}

function readTransaction(anns: Ann[]): { readOnly: boolean; propagation: string } | null {
  const tx = anns.find((a) => a.name === 'Transactional');
  if (!tx) return null;
  return {
    readOnly: /readOnly\s*=\s*true/.test(tx.args ?? ''),
    propagation: tx.args?.match(/Propagation\.(\w+)/)?.[1] ?? 'REQUIRED',
  };
}

/** 인터페이스면 구현체를 전부 후보로 올린다. 하나면 그대로. */
function resolveCandidates(ix: IndexReader, typeName: string): string[] {
  const t = ix.type(typeName);
  if (t && t.kind !== 'interface') return [typeName];
  const impls = ix.implementors(typeName).map((i) => i.name);
  return impls.length > 0 ? impls : [typeName];
}

function tableOf(ix: IndexReader, repoType: string): string {
  const entity = repoType.replace(/(Repository|Dao|Mapper)$/, '');
  const t = ix.type(entity);
  if (t) {
    const anns: Ann[] = JSON.parse(t.annotations);
    const table = anns.find((a) => a.name === 'Table');
    const name = table?.args?.match(/["']([^"']+)["']/)?.[1];
    if (name) return name;
  }
  return entity.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

const opOf = (m: string) => (WRITE_OPS.test(m) ? 'write' : 'read');

function dedupeRisks<T extends { at: string; why: string }>(risks: T[]): T[] {
  const seen = new Set<string>();
  return risks.filter((r) => {
    const k = `${r.at}|${r.why}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const round = (n: number) => Math.round(n * 100) / 100;
