/**
 * 데몬 접근 계층 — Raycast API에 의존하지 않는다.
 *
 * 분리한 이유는 두 가지다. 하나는 이 파일만 devkit 테스트 러너에서 그대로 돌려
 * 소켓 경로·응답 해석을 회귀로 잡을 수 있기 때문이고(Raycast를 띄우지 않고),
 * 다른 하나는 값이 지나가는 지점을 UI 코드와 섞지 않기 위해서다.
 *
 * 판정(정책·민감도)은 하지 않는다. 데몬이 전부 한다 — 클라이언트가 판정을 흉내내면
 * 두 곳이 어긋나고, 어긋난 쪽이 대개 더 느슨하다.
 */

import { request } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/** 검색 결과 한 줄. **값이 들어있지 않다** — 값은 고른 뒤에만 따로 가져온다 (스펙 §4.3). */
export type Hit = {
  key: string;
  alias: string[];
  matched: string;
  resourceType: string | null;
  desc: string | null;
  visibility: "public" | "secret";
  envs: string[];
};

export type ValueResult = {
  key: string;
  env: string;
  value: string | null;
  status: "ok" | "unset" | "locked";
  visibility: "public" | "secret";
};

export type Status = {
  mode: "full" | "reduced";
  degradedReason: string | null;
  items: number;
  envs: string[];
  defaultEnv: string;
};

export class DkcError extends Error {
  readonly code: string;
  readonly hint?: string;
  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

/**
 * 데몬 소켓 경로. `paths.ts`의 규칙을 그대로 따라간다.
 *
 * Raycast는 GUI 앱이라 셸 환경변수를 물려받지 않는다. macOS의 $TMPDIR은 사용자별
 * 고정 경로라 GUI에서도 같은 값이 나오지만, 다르게 잡은 사람을 위해 설정으로 덮을 수 있게 둔다.
 */
export function socketPath(override?: string): string {
  if (override && override.trim()) return override.trim();
  if (process.env.DKC_SOCKET) return process.env.DKC_SOCKET;
  const base =
    process.env.XDG_RUNTIME_DIR ?? (process.platform === "darwin" ? tmpdir() : join(homedir(), ".config-provider"));
  return join(base, "config-provider", "daemon.sock");
}

export type CallOptions = { socket?: string; query?: Record<string, string | undefined>; timeoutMs?: number };

async function call<T>(path: string, opts: CallOptions = {}): Promise<T> {
  const sock = socketPath(opts.socket);
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) qs.set(k, v);

  const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(
      {
        socketPath: sock,
        path: qs.toString() ? `${path}?${qs}` : path,
        method: "GET",
        // 커넥션 풀을 쓰지 않는다. 데몬이 재기동되면 죽은 소켓을 재사용해 EPIPE가 난다.
        agent: false,
        // Raycast는 사람이 직접 쓰는 창구다. UI·CLI와 같은 소유자 자격으로 부른다.
        headers: { "x-dkc-caller": "owner" },
      },
      (r) => {
        let data = "";
        r.setEncoding("utf8");
        r.on("data", (c) => {
          data += c;
        });
        r.on("end", () => resolve({ status: r.statusCode ?? 0, text: data }));
      },
    );
    req.setTimeout(opts.timeoutMs ?? 5000, () => {
      req.destroy(new DkcError("DAEMON_TIMEOUT", "데몬이 응답하지 않습니다", "dkc status로 상태를 확인하세요."));
    });
    req.on("error", (err) =>
      reject(
        err instanceof DkcError
          ? err
          : new DkcError(
              "DAEMON_UNAVAILABLE",
              `데몬에 연결할 수 없습니다 (${sock})`,
              "dkc daemon start로 데몬을 띄우거나, 설정에서 소켓 경로를 지정하세요.",
            ),
      ),
    );
    req.end();
  });

  let body: { ok?: boolean; data?: T; error?: { code?: string; message?: string; hint?: string } };
  try {
    body = res.text ? JSON.parse(res.text) : {};
  } catch {
    throw new DkcError("DAEMON_BAD_RESPONSE", "데몬 응답을 JSON으로 읽을 수 없습니다");
  }
  if (!body.ok) {
    const e = body.error ?? {};
    throw new DkcError(e.code ?? `HTTP_${res.status}`, e.message ?? `요청이 실패했습니다 (HTTP ${res.status})`, e.hint);
  }
  return body.data as T;
}

export function getStatus(opts: CallOptions = {}): Promise<Status> {
  return call<Status>("/status", opts);
}

/** 검색어가 있을 때. 메타데이터만 오간다. */
export async function searchKeys(query: string, opts: CallOptions = {}): Promise<Hit[]> {
  const data = await call<{ hits: Hit[] }>("/alias/search", { ...opts, query: { q: query, limit: "30" } });
  return data.hits;
}

/** 검색어가 없을 때의 전체 목록. `values=true`를 붙이지 않으므로 값은 실려오지 않는다. */
export async function listKeys(opts: CallOptions = {}): Promise<Hit[]> {
  const data = await call<{
    items: Array<{
      key: string;
      alias: string[];
      resourceType: string | null;
      desc: string | null;
      visibility: "public" | "secret";
      envs: string[];
    }>;
  }>("/items", opts);
  return data.items
    .map((it) => ({ ...it, matched: it.key }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** 값은 고른 항목 하나에 대해서만, 그 순간에만 가져온다. */
export function getValue(key: string, env: string, opts: CallOptions = {}): Promise<ValueResult> {
  return call<ValueResult>(`/config/${encodeURIComponent(key)}`, { ...opts, query: { env } });
}

/** 목록 한 줄에 붙일 부연. 값은 절대 넣지 않는다. */
export function subtitleOf(hit: Hit): string {
  const alias = hit.alias.join(" · ");
  return [alias, hit.desc].filter(Boolean).join(" — ");
}
