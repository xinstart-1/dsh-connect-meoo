/**
 * 插件自己的状态文件（**界面偏好**，不是模型路由配置）。
 *
 * 为什么不用 DSH 的 settings：这些开关（胶囊、侧栏入口、刷新间隔、禁用模型）
 * 要求「点一下立即生效、不经过保存」。写进 settings 意味着每次调一下都要过
 * 「改配置 → 重载插件」。所以它们落在自己的 JSON 文件里，读写只碰这一个文件。
 *
 * 位置：`$DSH_HOME/dsh-connect-meoo-state.json`（`DSH_HOME` 未设时为 `~/.dsh`）。
 * 写盘走「临时文件 + rename」，权限 0o600 —— 读到半个 JSON 会让用户以为设置丢了。
 *
 * @module dsh-connect-meoo/state
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { STATE_FILENAME } from './constants.ts';

/** 刷新间隔的五档（1 / 5 / 10 / 30 / 60 分钟）。 */
export const POLL_INTERVAL_CHOICES: readonly number[] = Object.freeze([
  60_000,
  300_000,
  600_000,
  1_800_000,
  3_600_000,
]);

/** 插件状态。 */
export interface MeooPluginState {
  schemaVersion: 1;
  /**
   * 被用户关掉的模型 id。
   *
   * 存禁用名单而不是启用名单：上游随时上下架模型，启用名单会让新上架的模型
   * 默认不可见，用户得先知道它存在才可能勾上。
   */
  disabledModels: string[];
  /** 状态刷新间隔；只能是 {@link POLL_INTERVAL_CHOICES} 之一。 */
  pollIntervalMs: number;
  /** 输入框左侧的积分读数。 */
  composerPill: boolean;
  /** 侧边栏入口（占全局座位，默认关）。 */
  sidebarPanel: boolean;
}

/** 默认状态。 */
export const DEFAULT_STATE: MeooPluginState = Object.freeze({
  schemaVersion: 1,
  disabledModels: [],
  pollIntervalMs: 300_000,
  composerPill: true,
  sidebarPanel: false,
}) as MeooPluginState;

/**
 * 归一化任意读到的值。
 *
 * 逐字段回落而不是整份丢弃：一份里 `pollIntervalMs` 被写坏，不该顺带把
 * 用户的 `disabledModels` 也清掉。
 * @param raw - 读到的 JSON（任意形状）。
 * @returns 合法状态。
 */
export function normalizeState(raw: unknown): MeooPluginState {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_STATE, disabledModels: [] };
  const record = raw as Record<string, unknown>;

  const disabled = Array.isArray(record.disabledModels)
    ? record.disabledModels.filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    : [];

  const interval = record.pollIntervalMs;

  return {
    schemaVersion: 1,
    disabledModels: disabled,
    // 封闭的五档，且**只认数字**：手写的 `0`、`'600000'` 一律回落。
    // 这个数字直接驱动 setInterval，「不刷新」和「疯狂刷新」都不是用户想要的。
    pollIntervalMs:
      typeof interval === 'number' && POLL_INTERVAL_CHOICES.includes(interval)
        ? interval
        : DEFAULT_STATE.pollIntervalMs,
    composerPill:
      typeof record.composerPill === 'boolean' ? record.composerPill : DEFAULT_STATE.composerPill,
    sidebarPanel:
      typeof record.sidebarPanel === 'boolean' ? record.sidebarPanel : DEFAULT_STATE.sidebarPanel,
  };
}

/**
 * 状态文件路径。
 * @param env - 环境变量（测试注入）。
 * @returns 绝对路径。
 */
export function statePath(env: NodeJS.ProcessEnv = process.env): string {
  const home =
    typeof env.DSH_HOME === 'string' && env.DSH_HOME.length > 0
      ? env.DSH_HOME
      : join(homedir(), '.dsh');
  return join(home, STATE_FILENAME);
}

/**
 * 读状态。文件不存在、坏 JSON、字段非法都回落到默认值（永不抛）。
 * @param env - 环境变量（测试注入）。
 * @returns 合法状态。
 */
export async function readState(env: NodeJS.ProcessEnv = process.env): Promise<MeooPluginState> {
  let text: string;
  try {
    text = await readFile(statePath(env), 'utf8');
  } catch {
    return { ...DEFAULT_STATE, disabledModels: [] };
  }
  try {
    return normalizeState(JSON.parse(text));
  } catch {
    return { ...DEFAULT_STATE, disabledModels: [] };
  }
}

/**
 * 合并写入。`patch` 里未出现的键保持原值；返回写后的完整状态。
 * @param patch - 要改的字段。
 * @param env - 环境变量（测试注入）。
 * @returns 写后的状态。
 */
export async function writeState(
  patch: Partial<MeooPluginState>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MeooPluginState> {
  const current = await readState(env);
  const next = normalizeState({
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
  });

  const path = statePath(env);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
  return next;
}
