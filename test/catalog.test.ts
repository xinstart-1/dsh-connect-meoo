/**
 * 目录解析的测试。
 *
 * 重点钉住三件事：
 * 1. 三种包络形状都要认（`{models}` / `{data}` / 裸数组）；
 * 2. 表外 id 必须落到保守值，**不能**把 1M 上下文乱许出去；
 * 3. 坏条目（缺 id、重复 id）必须被丢掉，不能出现在选择器里。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalModelId,
  DEFAULT_MODEL_ID,
  FALLBACK_CATALOG,
  MODEL_SPECS,
  normalizeModelId,
  parseAgentModels,
  parseGatewayModels,
  specOf,
} from '../src/protocol/catalog.ts';
import { normalizeState } from '../src/state.ts';

test('parseGatewayModels 认 {models:[...]} 包络', () => {
  const models = parseGatewayModels({
    models: [{ id: 'glm-5.2', name: 'GLM-5.2' }, { id: 'qwen3.8-flash' }],
  });
  assert.equal(models.length, 2);
  assert.equal(models[0]?.id, 'glm-5.2');
  assert.equal(models[0]?.name, 'GLM-5.2');
  // 没有 name 的条目用规格表里的展示名。
  assert.equal(models[1]?.name, 'Qwen3.8-Flash');
});

test('parseGatewayModels 认 {data:[...]} 包络', () => {
  const models = parseGatewayModels({ data: ['glm-5.2', 'deepseek-v4-pro-0813'] });
  assert.deepEqual(
    models.map((model) => model.id),
    ['glm-5.2', 'deepseek-v4-pro-0813'],
  );
  assert.equal(models[1]?.name, 'DeepSeek V4 Pro');
});

test('parseGatewayModels 认裸数组', () => {
  const models = parseGatewayModels([{ id: 'qwen3.8-flash' }]);
  assert.equal(models.length, 1);
  assert.equal(models[0]?.vision, true, 'Qwen3.8 Flash 是原生多模态');
});

test('parseGatewayModels 丢掉缺 id 与重复 id 的条目', () => {
  const models = parseGatewayModels([
    { id: 'glm-5.2' },
    { name: '没有 id' },
    { id: '   ' },
    'glm-5.2',
    'qwen3.8-max',
  ]);
  assert.deepEqual(
    models.map((model) => model.id),
    ['glm-5.2', 'qwen3.8-max'],
  );
});

test('parseGatewayModels 对非对象输入返回空数组（永不抛）', () => {
  assert.deepEqual(parseGatewayModels(null), []);
  assert.deepEqual(parseGatewayModels(undefined), []);
  assert.deepEqual(parseGatewayModels('nope'), []);
  assert.deepEqual(parseGatewayModels(42), []);
});

test('parseGatewayModels 尊重上游给的 context / max_output', () => {
  const models = parseGatewayModels({
    models: [{ id: 'glm-5.2', context: 512_000, max_output: 65_536 }],
  });
  assert.equal(models[0]?.contextWindow, 512_000);
  assert.equal(models[0]?.maxTokens, 65_536);
});

test('表外 id 落到保守值，不许乱许 1M 上下文', () => {
  const spec = specOf('some-brand-new-model');
  assert.equal(spec.contextWindow, 200_000);
  assert.equal(spec.maxTokens, 64_000);
  assert.equal(spec.vision, false, '表外 id 不猜多模态');
  assert.equal(spec.name, 'some-brand-new-model');
});

test('规格表里每个 id 都唯一且有正的上下文/输出上限', () => {
  const ids = new Set();
  for (const spec of MODEL_SPECS) {
    assert.equal(ids.has(spec.id), false, `重复 id: ${spec.id}`);
    ids.add(spec.id);
    assert.ok(spec.contextWindow > 0, `${spec.id} 的 contextWindow 必须为正`);
    assert.ok(spec.maxTokens > 0, `${spec.id} 的 maxTokens 必须为正`);
    assert.ok(spec.maxTokens <= spec.contextWindow, `${spec.id} 的输出上限不该超过上下文`);
  }
});

test('静态规格表与官方网关目录完全一致，不保留不可关闭的幽灵模型', () => {
  const officialIds = [
    'qwen3.8-flash',
    'qwen3.8-max',
    'qwen3.7-max',
    'qwen3.7-plus',
    'deepseek-v4.1-flash-1017',
    'deepseek-v4-pro-0813',
    'deepseek-v4-flash-0731',
    'moonshot/kimi-k3.1-pro',
    'moonshot/kimi-k3',
    'MiniMax/MiniMax-M3.1-Flash',
    'bigmodel/glm-5.3-flash',
    'bigmodel/glm-5.3',
    'glm-5.2-fast-preview',
    'glm-5.2',
  ];
  const ids = MODEL_SPECS.map((model) => model.id).sort();
  assert.deepEqual(ids, [...officialIds].sort());
  assert.equal(ids.includes('qwen3-vl-plus'), false);
  assert.equal(ids.includes('kimi-k3'), false);
  assert.equal(ids.includes('kimi-k3.1-pro'), false);
});

test('禁用官方目录中其余模型后，只保留用户启用的模型', () => {
  const enabledIds = new Set(['deepseek-v4.1-flash-1017', 'bigmodel/glm-5.3-flash']);
  const disabledModels = MODEL_SPECS.filter((model) => !enabledIds.has(model.id)).map((model) => model.id);
  const visibleModels = MODEL_SPECS.filter((model) => !disabledModels.includes(model.id));

  assert.deepEqual(
    visibleModels.map((model) => model.id),
    ['deepseek-v4.1-flash-1017', 'bigmodel/glm-5.3-flash'],
  );
  assert.equal(visibleModels.some((model) => model.id.includes('kimi')), false);
  assert.equal(visibleModels.some((model) => model.id === 'qwen3-vl-plus'), false);
});

test('FALLBACK_CATALOG 就是规格表，且非空', () => {
  assert.ok(FALLBACK_CATALOG.length > 0);
  assert.equal(FALLBACK_CATALOG.length, MODEL_SPECS.length);
});

test('normalizeModelId 去 provider 前缀并回落到目录第一个', () => {
  const catalog = parseGatewayModels({ models: [{ id: 'glm-5.2' }, { id: 'qwen3.8-flash' }] });
  assert.equal(normalizeModelId('meoo/glm-5.2', catalog), 'glm-5.2');
  assert.equal(normalizeModelId('  qwen3.8-flash  ', catalog), 'qwen3.8-flash');
  // 目录里没有的 id 回落到第一个。
  assert.equal(normalizeModelId('not-there', catalog), 'glm-5.2');
  // 空目录回落到 DEFAULT_MODEL_ID。
  assert.equal(normalizeModelId(undefined, []), DEFAULT_MODEL_ID);
});

// ---------------------------------------------------------------------------
// 官网目录：价格档位 / 说明 / 夜间折扣的唯一真源。
// 网关 /models 只回裸 id，这些信息只能从 /api/v1/agent/models 拿。
// ---------------------------------------------------------------------------

test('parseAgentModels 用 modelsValue 把官网 key 映射成网关 id', () => {
  const models = parseAgentModels({
    success: true,
    data: {
      models: [
        { key: 'deepseekV41Flash1017', label: 'DeepSeek V4.1 Flash', price: 'cheap', context_window: 200000, max_token: 64000, multimodal: true },
        { key: 'glm5.2', label: 'GLM-5.2', price: 'expensive', context_window: 200000, max_token: 64000, multimodal: false },
      ],
      modelsValue: {
        deepseekV41Flash1017: 'deepseek-v4.1-flash-1017',
        'glm5.2': 'glm-5.2',
      },
    },
  });
  assert.equal(models.length, 2);
  // 关键：id 必须是 modelsValue 映射后的网关 id，否则请求会 404。
  assert.equal(models[0]?.id, 'deepseek-v4.1-flash-1017');
  assert.equal(models[0]?.name, 'DeepSeek V4.1 Flash');
  assert.equal(models[0]?.price, 'cheap');
  assert.equal(models[0]?.vision, true);
  assert.equal(models[1]?.id, 'glm-5.2');
  assert.equal(models[1]?.price, 'expensive');
  assert.equal(models[1]?.vision, false);
});

test('parseAgentModels 跳过 auto 档与非法 price', () => {
  const models = parseAgentModels({
    data: {
      models: [
        { key: 'auto', label: 'Auto', price: null },
        { key: 'qwen3.8-flash', label: 'Qwen3.8-Flash', price: 'not-a-tier' },
      ],
      modelsValue: { 'qwen3.8-flash': 'qwen3.8-flash' },
    },
  });
  assert.equal(models.length, 1, 'auto 是智能路由档，不是可寻址模型');
  assert.equal(models[0]?.id, 'qwen3.8-flash');
  assert.equal(models[0]?.price, undefined, '认不出的档位宁可不显示，也不瞎猜');
});

test('parseAgentModels 解析夜间折扣', () => {
  const models = parseAgentModels({
    data: {
      models: [
        {
          key: 'qwen3.8-flash',
          label: 'Qwen3.8-Flash',
          price: 'cheap',
          discountLabel: 4,
          discountStartTime: '22:00',
          discountEndTime: '08:00',
        },
      ],
      modelsValue: { 'qwen3.8-flash': 'qwen3.8-flash' },
    },
  });
  assert.deepEqual(models[0]?.discount, { label: 4, start: '22:00', end: '08:00' });
});

test('parseAgentModels 对坏形状返回空数组（不抛）', () => {
  for (const payload of [null, undefined, {}, { data: null }, { data: { models: 'nope' } }, 'x']) {
    assert.deepEqual(parseAgentModels(payload), []);
  }
});

test('静态规格表的价格档位与官网一致（离线兜底也不瞎写）', () => {
  const byId = new Map(MODEL_SPECS.map((spec) => [spec.id, spec]));
  // 官网实测值（2026-11-10）。
  assert.equal(byId.get('qwen3.8-flash')?.price, 'cheap');
  assert.equal(byId.get('qwen3.8-max')?.price, 'veryExpensive');
  assert.equal(byId.get('qwen3.7-max')?.price, 'expensive');
  assert.equal(byId.get('deepseek-v4-pro-0813')?.price, 'moderate');
  assert.equal(byId.get('glm-5.2')?.price, 'expensive');
});

test('旧的 kimi 无前缀 id 归一成官方 id（升级不丢禁用选择）', () => {
  // 旧版本规格表漏了 `moonshot/` 前缀，那时候点下的「关闭」存的就是无前缀 id。
  assert.equal(canonicalModelId('kimi-k3'), 'moonshot/kimi-k3');
  assert.equal(canonicalModelId('kimi-k3.1-pro'), 'moonshot/kimi-k3.1-pro');
  // 已经是官方 id / 认不出的 id 必须原样返回，不能擅自改名。
  assert.equal(canonicalModelId('moonshot/kimi-k3'), 'moonshot/kimi-k3');
  assert.equal(canonicalModelId('glm-5.2'), 'glm-5.2');
  assert.equal(canonicalModelId('brand-new-model'), 'brand-new-model');
});

test('normalizeState 归一旧 id 并去重', () => {
  const state = normalizeState({
    disabledModels: ['kimi-k3', 'moonshot/kimi-k3', 'kimi-k3.1-pro', ''],
  });
  assert.deepEqual(state.disabledModels, ['moonshot/kimi-k3', 'moonshot/kimi-k3.1-pro']);
});

test('官方声明的 200K 上下文被抬到实测下界 240K', () => {
  // 秒悟官网对每个模型都写 context_window: 200000，实测 32 万字符仍能正确回忆开头内容。
  const models = parseAgentModels({
    data: {
      models: [
        {
          key: 'deepseekV41Flash1017',
          context_window: 200_000,
          max_token: 64_000,
          label: 'DeepSeek V4.1 Flash',
        },
      ],
      modelsValue: { deepseekV41Flash1017: 'deepseek-v4.1-flash-1017' },
    },
  });
  assert.equal(models.length, 1);
  assert.equal(models[0]?.contextWindow, 240_000, '声明值低于实测下界时抬到 240K');
  assert.equal(models[0]?.maxTokens, 64_000, '输出上限保持官方声明');
});

test('声明值高于下界时以声明值为准，不被压回去', () => {
  const models = parseAgentModels({
    data: {
      models: [{ key: 'bigmodel/glm-5.3', context_window: 1_000_000, max_token: 64_000 }],
      modelsValue: { 'bigmodel/glm-5.3': 'bigmodel/glm-5.3' },
    },
  });
  assert.equal(models[0]?.contextWindow, 1_000_000);
});
