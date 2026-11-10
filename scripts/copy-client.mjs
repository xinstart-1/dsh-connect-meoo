/**
 * 构建收尾：把浏览器半侧原样拷到 `lib/client.js`。
 *
 * 为什么不用 tsdown 的 hook：入口产物与这份拷贝的先后顺序要在**构建脚本层面**
 * 保证（`build` = tsdown && 本脚本），而不是依赖 bundler 的钩子名 —— 钩子名一旦
 * 随版本变化，产物会静默少一个文件，而缺失的 `./client` 在宿主上只表现为
 * 「插件没有界面」，很难查。
 */

import { copyFile, mkdir, stat } from 'node:fs/promises';

const source = 'src/client/bundle.js';
const target = 'lib/client.js';

await mkdir('lib', { recursive: true });
await copyFile(source, target);

// 自检：两份文件必须字节数一致，否则「拷了但拷错了」比「没拷」更难看。
const [from, to] = await Promise.all([stat(source), stat(target)]);
if (from.size !== to.size) {
  throw new Error(`客户端 bundle 拷贝不完整：${source}=${String(from.size)} vs ${target}=${String(to.size)}`);
}
console.log(`client bundle: ${target} (${String(to.size)} bytes)`);
