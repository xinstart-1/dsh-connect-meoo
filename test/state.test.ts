/**
 * 插件状态文件的测试。
 *
 * 重点：**逐字段回落**而不是整份丢弃 —— 一份里 `pollIntervalMs` 被写坏，
 * 不该顺带把用户的 `disabledModels` 也清掉。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  DEFAULT_STATE,
  POLL_INTERVAL_CHOICES,
  normalizeState,
  readState,
  statePath,
  writeState,
} from '../src/state.ts';

const temporaryDirs: string[] = [];

async function freshHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-meoo-state-'));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('statePath 跟随 DSH_HOME', () => {
  assert.equal(statePath({ DSH_HOME: 'C:/x' }), join('C:/x', 'dsh-connect-meoo-state.json'));
  // 未设 DSH_HOME 时落在 ~/.dsh 下（只断言文件名，不依赖真实 home）。
  assert.ok(statePath({}).endsWith('dsh-connect-meoo-state.json'));
});

test('normalizeState 对非对象返回默认值', () => {
  for (const raw of [null, undefined, 42, 'x', []]) {
    const state = normalizeState(raw);
    assert.equal(state.schemaVersion, 1);
    assert.deepEqual(state.disabledModels, []);
    assert.equal(state.pollIntervalMs, DEFAULT_STATE.pollIntervalMs);
  }
});

test('normalizeState 逐字段回落，不因一个坏字段丢掉别的', () => {
  const state = normalizeState({
    disabledModels: ['glm-5.2', '', 42, 'qwen3.8-max'],
    pollIntervalMs: 12_345, // 不在五档里
    composerPill: 'yes', // 不是布尔
    sidebarPanel: true,
  });
  assert.deepEqual(state.disabledModels, ['glm-5.2', 'qwen3.8-max'], '字符串且非空的才留');
  assert.equal(state.pollIntervalMs, DEFAULT_STATE.pollIntervalMs, '非法间隔回落默认');
  assert.equal(state.composerPill, DEFAULT_STATE.composerPill);
  assert.equal(state.sidebarPanel, true, '合法字段不受影响');
});

test('normalizeState 只认数字类型的五档间隔', () => {
  for (const interval of POLL_INTERVAL_CHOICES) {
    assert.equal(normalizeState({ pollIntervalMs: interval }).pollIntervalMs, interval);
  }
  // 字符串即使能转成数字也不接受：配置里写错一个引号不该静默生效。
  assert.equal(normalizeState({ pollIntervalMs: '600000' }).pollIntervalMs, DEFAULT_STATE.pollIntervalMs);
  assert.equal(normalizeState({ pollIntervalMs: 0 }).pollIntervalMs, DEFAULT_STATE.pollIntervalMs);
});

test('readState 在文件不存在时返回默认值（永不抛）', async () => {
  const home = await freshHome();
  const state = await readState({ DSH_HOME: home });
  assert.deepEqual(state.disabledModels, []);
  assert.equal(state.pollIntervalMs, DEFAULT_STATE.pollIntervalMs);
});

test('readState 在坏 JSON 时返回默认值', async () => {
  const home = await freshHome();
  await writeFile(join(home, 'dsh-connect-meoo-state.json'), '{ not json', 'utf8');
  const state = await readState({ DSH_HOME: home });
  assert.equal(state.pollIntervalMs, DEFAULT_STATE.pollIntervalMs);
});

test('writeState 合并写入并返回完整状态', async () => {
  const home = await freshHome();
  const env = { DSH_HOME: home };
  const first = await writeState({ sidebarPanel: true }, env);
  assert.equal(first.sidebarPanel, true);

  const second = await writeState({ composerPill: false }, env);
  assert.equal(second.sidebarPanel, true, '没传的字段保持原值');
  assert.equal(second.composerPill, false);

  // 再从磁盘读一次，确认真的落盘了。
  const reloaded = await readState(env);
  assert.equal(reloaded.sidebarPanel, true);
  assert.equal(reloaded.composerPill, false);
});
