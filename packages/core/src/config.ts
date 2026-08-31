/**
 * 설정 병합 (plan.md §6.1).
 *
 * 순서: manifest 기본값 → ~/.devkit/config.toml → 프로파일 → <repo>/.devkit/config.toml
 *       → DEVKIT_* 환경변수 → 호출 시 입력
 *
 * 시크릿 값 자체는 절대 여기 안 들어온다. `keychain://` 참조만 담긴다 (secrets.ts).
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { parseToml, type TomlValue } from './toml.ts';
import { globalConfigPath, profileConfigPath } from './paths.ts';
import { DevkitError } from './errors.ts';

export type Config = Record<string, TomlValue>;

export type RepoConfig = {
  name: string;
  path: string;
  lang: string[];
  framework: string[];
  entrypointGlobs: string[];
};

export type LoadOptions = {
  /** 프로젝트 설정을 읽어올 저장소 경로. 생략하면 프로젝트 계층을 건너뛴다. */
  repoPath?: string;
  /** 프로파일 이름. 생략하면 전역 설정의 default_profile을 따른다. */
  profile?: string;
};

export function loadConfig(opts: LoadOptions = {}): Config {
  const layers: Config[] = [];

  layers.push(readTomlFile(globalConfigPath()));

  const profile = opts.profile ?? process.env.DEVKIT_PROFILE ?? (layers[0].default_profile as string | undefined);
  if (profile) layers.push(readTomlFile(profileConfigPath(profile)));

  if (opts.repoPath) layers.push(readTomlFile(join(opts.repoPath, '.devkit', 'config.toml')));

  layers.push(envLayer());

  const merged = layers.reduce<Config>((acc, layer) => deepMerge(acc, layer), {});
  if (profile) merged.__profile = profile;
  return merged;
}

/** 설정에 등록된 저장소를 정규화해 돌려준다. */
export function resolveRepo(config: Config, name: string): RepoConfig {
  const repos = (config.repos ?? {}) as Record<string, Record<string, TomlValue>>;
  const entry = repos[name];
  if (!entry) {
    const known = Object.keys(repos);
    throw new DevkitError({
      code: 'REPO_NOT_CONFIGURED',
      message: `저장소 '${name}'가 설정에 없습니다`,
      hint: known.length
        ? `설정된 저장소: ${known.join(', ')}`
        : '~/.devkit/config.toml 에 [repos.<name>] 블록을 추가하세요.',
      retryable: false,
      fixCommand: `dk config add-repo ${name} --path <경로>`,
    });
  }
  const path = expandHome(String(entry.path ?? ''));
  if (!path || !existsSync(path)) {
    throw new DevkitError({
      code: 'REPO_PATH_MISSING',
      message: `저장소 '${name}'의 경로가 존재하지 않습니다: ${path || '(미설정)'}`,
      hint: '~/.devkit/config.toml 의 path 값을 확인하세요.',
      retryable: false,
    });
  }
  return {
    name,
    path,
    lang: toStringArray(entry.lang),
    framework: toStringArray(entry.framework),
    entrypointGlobs: toStringArray(entry.entrypoint_globs),
  };
}

export function listRepos(config: Config): string[] {
  return Object.keys((config.repos ?? {}) as Record<string, unknown>);
}

function readTomlFile(path: string): Config {
  if (!existsSync(path)) return {};
  return parseToml(readFileSync(path, 'utf8'), path);
}

/**
 * DEVKIT_DB__PAYMENT__READONLY=true → { db: { payment: { readonly: true } } }
 * 이중 밑줄이 계층 구분자다.
 */
function envLayer(): Config {
  const out: Config = {};
  for (const [key, raw] of Object.entries(process.env)) {
    if (!key.startsWith('DEVKIT_') || raw === undefined) continue;
    if (key === 'DEVKIT_HOME' || key === 'DEVKIT_PROFILE' || key === 'DEVKIT_PLUGINS_DIR') continue;
    const parts = key.slice('DEVKIT_'.length).toLowerCase().split('__');
    let cur = out;
    for (const part of parts.slice(0, -1)) {
      if (typeof cur[part] !== 'object' || Array.isArray(cur[part])) cur[part] = {};
      cur = cur[part] as Config;
    }
    cur[parts[parts.length - 1]] = coerce(raw);
  }
  return out;
}

function coerce(raw: string): TomlValue {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const n = Number(raw);
  return raw !== '' && Number.isFinite(n) ? n : raw;
}

function deepMerge(base: Config, layer: Config): Config {
  const out: Config = { ...base };
  for (const [key, value] of Object.entries(layer)) {
    const prev = out[key];
    if (isTable(prev) && isTable(value)) out[key] = deepMerge(prev as Config, value as Config);
    else out[key] = value;
  }
  return out;
}

function isTable(v: unknown): v is Config {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toStringArray(v: TomlValue | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map(String);
}

export function expandHome(p: string): string {
  if (p.startsWith('~/')) return resolve(homedir(), p.slice(2));
  return p ? resolve(p) : p;
}
