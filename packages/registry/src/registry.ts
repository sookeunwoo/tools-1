/**
 * 툴 레지스트리 — manifest 로딩과 계약 검증.
 *
 * plugins/<name>/manifest.json 을 스캔한다. 등록 절차가 따로 없다:
 * 디렉토리를 만들면 그게 곧 등록이다 (에이전트가 툴을 추가하기 쉽게).
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pluginsDir } from '#core/paths.ts';
import { DevkitError } from '#core/errors.ts';
import { validate, formatIssues } from '#core/schema.ts';
import type { Manifest, ToolModule } from '#core/contract.ts';

const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['name', 'version', 'summary', 'whenToUse', 'inputSchema', 'outputSchema', 'sideEffects', 'concurrency', 'determinism', 'timeoutSec', 'requiresApproval'],
  properties: {
    name: { type: 'string', pattern: '^[a-z][a-z0-9-]*$' },
    version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    summary: { type: 'string', minLength: 1 },
    whenToUse: { type: 'string', minLength: 1 },
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    sideEffects: { enum: ['read', 'write', 'external'] },
    concurrency: {
      type: 'object',
      required: ['mode'],
      properties: {
        mode: { enum: ['safe', 'exclusive'] },
        resourceKey: { type: ['string', 'null'], default: null },
      },
    },
    determinism: { enum: ['pure', 'by-commit', 'nondeterministic'] },
    timeoutSec: { type: 'number', minimum: 1, maximum: 3600 },
    requiresApproval: { type: 'boolean' },
    costHint: { type: 'string' },
    evidenceOptional: { type: 'boolean', default: false },
  },
};

export type ToolEntry = { manifest: Manifest; dir: string; entryPath: string };

let cache: Map<string, ToolEntry> | null = null;

export function listTools(): ToolEntry[] {
  return [...loadAll().values()].sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
}

export function getTool(name: string): ToolEntry {
  const entry = loadAll().get(name);
  if (!entry) {
    const known = [...loadAll().keys()].sort();
    throw new DevkitError({
      code: 'TOOL_NOT_FOUND',
      message: `툴 '${name}'을 찾을 수 없습니다`,
      hint: known.length ? `사용 가능한 툴: ${known.join(', ')}` : `${pluginsDir()} 에 툴이 없습니다.`,
      retryable: false,
      fixCommand: `dk scaffold tool ${name}`,
    });
  }
  return entry;
}

export async function loadModule(entry: ToolEntry): Promise<ToolModule> {
  const mod = (await import(entry.entryPath)) as Partial<ToolModule>;
  if (typeof mod.run !== 'function') {
    throw new DevkitError({
      code: 'TOOL_BAD_MODULE',
      message: `${entry.entryPath} 가 run() 함수를 export하지 않습니다`,
      hint: 'export async function run(input, ctx) { return { data, evidence } } 형태여야 합니다.',
      retryable: false,
      source: { file: entry.entryPath.replace(/^.*\/devkit\//, ''), line: 1 },
    });
  }
  return mod as ToolModule;
}

export function invalidateRegistry(): void {
  cache = null;
}

function loadAll(): Map<string, ToolEntry> {
  if (cache) return cache;
  const dir = pluginsDir();
  const found = new Map<string, ToolEntry>();

  if (!existsSync(dir)) {
    cache = found;
    return found;
  }

  for (const name of readdirSync(dir, { withFileTypes: true })) {
    if (!name.isDirectory()) continue;
    const toolPath = join(dir, name.name);
    const manifestPath = join(toolPath, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    const manifest = readManifest(manifestPath);
    if (manifest.name !== name.name) {
      throw new DevkitError({
        code: 'TOOL_NAME_MISMATCH',
        message: `${manifestPath}: manifest.name('${manifest.name}')과 디렉토리명('${name.name}')이 다릅니다`,
        hint: '둘을 일치시키세요. 레지스트리는 디렉토리명을 기준으로 스캔합니다.',
        retryable: false,
      });
    }

    const entryPath = join(toolPath, 'index.ts');
    if (!existsSync(entryPath)) {
      throw new DevkitError({
        code: 'TOOL_ENTRY_MISSING',
        message: `${toolPath}/index.ts 가 없습니다`,
        hint: 'manifest.json 이 있는 툴 디렉토리에는 index.ts 가 있어야 합니다.',
        retryable: false,
        fixCommand: `dk scaffold tool ${name.name}`,
      });
    }
    found.set(manifest.name, { manifest, dir: toolPath, entryPath });
  }

  cache = found;
  return found;
}

function readManifest(path: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new DevkitError({
      code: 'MANIFEST_PARSE_ERROR',
      message: `${path}: JSON 파싱 실패 — ${(err as Error).message}`,
      retryable: false,
    });
  }
  const result = validate(MANIFEST_SCHEMA, parsed);
  if (!result.valid) {
    throw new DevkitError({
      code: 'MANIFEST_INVALID',
      message: `${path}: 계약 위반 — ${formatIssues(result.issues)}`,
      hint: '툴 계약 정의는 packages/core/src/contract.ts 를 참고하세요.',
      retryable: false,
    });
  }
  return result.value as Manifest;
}
