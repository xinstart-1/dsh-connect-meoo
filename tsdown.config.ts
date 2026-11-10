/**
 * 构建：宿主半侧（TS → ESM）。
 *
 * 浏览器半侧**不进这个构建**：它是一份手写的经典脚本，由
 * `scripts/copy-client.mjs` 在 tsdown 之后原样拷到 `lib/client.js`。
 * 为什么不在 bundler 里做：宿主用 `<script>` 加载它、`require('react')`
 * 解析到宿主自己的 React，一旦被打包就会变成两份 React。
 */

import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  clean: true,
  outDir: 'lib',
  fixedExtension: false,
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-llm-pi-ai',
      '@deepseek-ai/schemastery',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-ai/api/openai-completions.lazy',
    ],
  },
});
