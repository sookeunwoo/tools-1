/**
 * Raycast 명령 — 키를 찾아 값을 클립보드로 꺼낸다.
 *
 * 흐름은 데몬의 2단계 조회를 그대로 따른다 (스펙 §4.3): 목록에는 메타데이터만 싣고,
 * **값은 고른 항목 하나에 대해서만** 그 순간 가져온다. 그래서 목록을 훑는 동안에는
 * 어떤 비밀값도 이 프로세스에 들어오지 않는다.
 *
 * 복사는 `concealed`로 한다 — Raycast 클립보드 기록에 비밀값이 남지 않게 한다.
 */

import { useEffect, useState } from "react";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  Action,
  ActionPanel,
  Clipboard,
  Icon,
  List,
  LaunchProps,
  Toast,
  closeMainWindow,
  getPreferenceValues,
  open,
  showHUD,
  showToast,
} from "@raycast/api";
import { DkcError, getStatus, getValue, listKeys, searchKeys, socketPath, subtitleOf, type Hit } from "./dkc";

const run = promisify(execFile);

const toDkcError = (err: unknown) => (err instanceof DkcError ? err : new DkcError("UNKNOWN", String(err)));

type Prefs = { defaultEnv: string; socketPath?: string; dkcPath?: string; uiUrl: string };

type State = {
  loading: boolean;
  hits: Hit[];
  envs: string[];
  defaultEnv: string;
  reduced: boolean;
  error?: DkcError;
};

export default function Command(props: LaunchProps<{ arguments: { query?: string } }>) {
  const prefs = getPreferenceValues<Prefs>();
  const opts = { socket: prefs.socketPath };
  // 셋 다 "이미 친 검색어"를 이어받는 경로다: 인자(config + Tab), Fallback Command(루트에서
  // 친 텍스트), 그리고 빈 상태. 무엇으로 열었든 다시 타이핑하게 만들지 않는다.
  const [query, setQuery] = useState(props.arguments?.query ?? props.fallbackText ?? "");
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<State>({
    loading: true,
    hits: [],
    envs: [],
    defaultEnv: prefs.defaultEnv || "dev",
    reduced: false,
  });

  // 상태는 한 번만 읽는다. 글자를 칠 때마다 부르면 왕복이 두 배가 되고, 이 화면에서
  // 가장 자주 일어나는 일이 바로 "글자를 치는 것"이다.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const status = await getStatus(opts);
        if (cancelled) return;
        setState((s) => ({
          ...s,
          envs: status.envs,
          // 설정이 비어 있으면 데몬의 기본 env를 따른다. prod는 항상 명시적으로 고르게 둔다.
          defaultEnv: prefs.defaultEnv?.trim() || status.defaultEnv,
          reduced: status.mode !== "full",
        }));
      } catch (err) {
        if (cancelled) return;
        setState((s) => ({ ...s, loading: false, error: toDkcError(err) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // 검색은 글자마다 돈다. 로컬 UDS라 왕복이 사실상 공짜여서 디바운스 없이도 즉각적이다.
  useEffect(() => {
    let cancelled = false;
    const trimmed = query.trim();

    (async () => {
      setState((s) => ({ ...s, loading: true }));
      try {
        const hits = trimmed ? await searchKeys(trimmed, opts) : await listKeys(opts);
        if (cancelled) return;
        setState((s) => ({ ...s, loading: false, hits, error: undefined }));
      } catch (err) {
        if (cancelled) return;
        const e = toDkcError(err);
        // 검색어가 비면 데몬이 QUERY_EMPTY를 준다 — 빈 목록이지 오류가 아니다.
        if (e.code === "QUERY_EMPTY") setState((s) => ({ ...s, loading: false, hits: [] }));
        else setState((s) => ({ ...s, loading: false, hits: [], error: e }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [query, reloadKey]);

  async function copy(hit: Hit, env: string, paste = false) {
    const toast = await showToast({ style: Toast.Style.Animated, title: `${hit.key} (${env}) 가져오는 중…` });
    try {
      const res = await getValue(hit.key, env, opts);
      if (res.status !== "ok" || res.value === null) {
        toast.style = Toast.Style.Failure;
        toast.title = `${hit.key} (${env})는 미설정입니다`;
        toast.message = "값이 아직 없습니다. UI나 dkc set으로 채우세요.";
        return;
      }
      // concealed: Raycast 클립보드 기록에 비밀값을 남기지 않는다.
      if (paste) await Clipboard.paste(res.value);
      else await Clipboard.copy(res.value, { concealed: true });
      await closeMainWindow();
      await showHUD(`${hit.key} (${env}) ${paste ? "붙여넣음" : "복사됨"}${res.visibility === "secret" ? " 🔒" : ""}`);
    } catch (err) {
      const e = toDkcError(err);
      toast.style = Toast.Style.Failure;
      toast.title = e.message;
      toast.message = e.hint;
    }
  }

  async function startDaemon() {
    const bin = prefs.dkcPath?.trim() || "dkc";
    const toast = await showToast({ style: Toast.Style.Animated, title: "데몬을 시작하는 중…" });
    try {
      await run(bin, ["daemon", "start"]);
      toast.style = Toast.Style.Success;
      toast.title = "데몬을 시작했습니다";
      setReloadKey((n) => n + 1);
    } catch (err) {
      toast.style = Toast.Style.Failure;
      toast.title = "데몬을 시작하지 못했습니다";
      toast.message = `${bin}의 전체 경로를 확장 설정에 넣어보세요 (${String(err).slice(0, 120)})`;
    }
  }

  const actionsFor = (hit: Hit) => {
    const envs = hit.envs.length ? hit.envs : [state.defaultEnv];
    const primary = envs.includes(state.defaultEnv) ? state.defaultEnv : envs[0];
    const rest = envs.filter((e) => e !== primary);
    return (
      <ActionPanel>
        <ActionPanel.Section>
          <Action title={`${primary} 값 복사`} icon={Icon.Clipboard} onAction={() => copy(hit, primary)} />
          <Action
            title={`${primary} 값 붙여넣기`}
            icon={Icon.Text}
            shortcut={{ modifiers: ["cmd", "shift"], key: "v" }}
            onAction={() => copy(hit, primary, true)}
          />
        </ActionPanel.Section>
        {rest.length > 0 && (
          <ActionPanel.Section title="다른 환경">
            {rest.map((env) => (
              <Action
                key={env}
                title={`${env} 값 복사`}
                icon={env === "prod" ? Icon.Warning : Icon.Clipboard}
                onAction={() => copy(hit, env)}
              />
            ))}
          </ActionPanel.Section>
        )}
        <ActionPanel.Section>
          <Action.CopyToClipboard
            title="key 이름 복사"
            content={hit.key}
            shortcut={{ modifiers: ["cmd", "shift"], key: "c" }}
          />
          <Action
            title="UI에서 열기"
            icon={Icon.Globe}
            shortcut={{ modifiers: ["cmd"], key: "o" }}
            onAction={() => open(prefs.uiUrl || "http://127.0.0.1:7777")}
          />
          <Action
            title="다시 읽기"
            icon={Icon.ArrowClockwise}
            shortcut={{ modifiers: ["cmd"], key: "r" }}
            onAction={() => setReloadKey((n) => n + 1)}
          />
        </ActionPanel.Section>
      </ActionPanel>
    );
  };

  return (
    <List
      isLoading={state.loading}
      searchText={query}
      onSearchTextChange={setQuery}
      searchBarPlaceholder="key · 별칭 · 설명으로 검색"
      throttle
    >
      {state.error ? (
        <List.EmptyView
          icon={Icon.BoltDisabled}
          title={state.error.message}
          description={state.error.hint ?? `소켓: ${socketPath(prefs.socketPath)}`}
          actions={
            <ActionPanel>
              <Action title="데몬 시작" icon={Icon.Play} onAction={startDaemon} />
              <Action title="다시 시도" icon={Icon.ArrowClockwise} onAction={() => setReloadKey((n) => n + 1)} />
            </ActionPanel>
          }
        />
      ) : (
        <>
          {state.reduced && (
            <List.Section title="축소 모드 — secret 값이 잠겨 있습니다 (dkc doctor)">{null}</List.Section>
          )}
          {state.hits.map((hit) => (
            <List.Item
              key={hit.key}
              icon={hit.visibility === "secret" ? Icon.Lock : Icon.Document}
              title={hit.key}
              subtitle={subtitleOf(hit)}
              accessories={[
                ...(hit.resourceType ? [{ tag: hit.resourceType }] : []),
                { text: hit.envs.join(" · ") },
              ]}
              actions={actionsFor(hit)}
            />
          ))}
          {!state.loading && state.hits.length === 0 && (
            <List.EmptyView
              icon={Icon.MagnifyingGlass}
              title={query.trim() ? `'${query.trim()}'에 맞는 항목이 없습니다` : "항목이 없습니다"}
              description="별칭을 추가하면 자연어로 찾을 수 있습니다 (dkc alias add)."
            />
          )}
        </>
      )}
    </List>
  );
}
