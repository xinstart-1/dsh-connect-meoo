/**
 * 适配器：模型兼容开关。
 *
 * 这里钉的是「缓存优化真的会发出去」的前置条件：pi-ai 只有在 compat 允许
 * 长保留时才会带 `prompt_cache_key` / `prompt_cache_retention`。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toPiModel } from '../src/llm/adapter.ts';

test('toPiModel 打开会话亲和与长缓存保留，同时不改动原有兼容项', () => {
  const model = toPiModel(
    {
      id: 'deepseek-v4.1-flash-1017',
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 128_000,
      maxTokens: 8_192,
      vision: false,
      reasoning: true,
    },
    'https://api.meoo.host/meoo-ai/compatible-mode/v1',
  );
  assert.equal(model.compat?.supportsDeveloperRole, false);
  assert.equal(model.compat?.maxTokensField, 'max_tokens');
  assert.equal(model.compat?.supportsReasoningEffort, true);
  assert.equal(model.compat?.sendSessionAffinityHeaders, true);
  assert.equal(model.compat?.sessionAffinityFormat, 'openai');
  assert.equal(model.compat?.supportsLongCacheRetention, true);
});
