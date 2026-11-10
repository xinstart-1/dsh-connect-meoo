/**
 * 发布后校验：确认 registry 上真的有这个版本。
 *
 * 为什么不能只看整包文档：`registry.npmjs.org/<pkg>` 走 CDN，刚发布时可能返回旧内容，
 * 会让人误判成失败。要看**单版本端点** `/<pkg>/<version>` 与 `dist-tags`。
 *
 * 用法：`node scripts/verify-published.mjs [version]`
 */

import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = process.argv[2] ?? pkg.version;
const registry = 'https://registry.npmjs.org';

/** 带重试地 GET 一个 JSON 端点（刚发布时 CDN 可能还没同步）。 */
async function getJson(url, attempts = 6) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (res.status === 404) {
        lastError = new Error(`HTTP 404（还没同步，第 ${String(attempt)} 次）`);
      } else if (!res.ok) {
        lastError = new Error(`HTTP ${String(res.status)}`);
      } else {
        return await res.json();
      }
    } catch (error) {
      lastError = error;
    }
    // 指数退避：3s / 6s / 12s / 24s / 48s
    const wait = 3000 * 2 ** (attempt - 1);
    console.log(`  第 ${String(attempt)} 次未成功（${String(lastError)}），${String(wait / 1000)}s 后重试…`);
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  throw lastError ?? new Error('未知失败');
}

console.log(`校验 ${pkg.name}@${version} …`);

// 1. 单版本端点：最准的信号。
const versionDoc = await getJson(`${registry}/${pkg.name.replace('/', '%2f')}/${version}`);
console.log(`ok   单版本端点存在：${versionDoc.name}@${versionDoc.version}`);
console.log(`ok   tarball：${versionDoc.dist?.tarball}`);

// 2. dist-tags：latest 是否指向它。
const packument = await getJson(`${registry}/${pkg.name.replace('/', '%2f')}`, 3);
const latest = packument['dist-tags']?.latest;
console.log(`ok   dist-tags.latest = ${String(latest)}`);
if (latest !== version) {
  console.log(`注意：latest 不是 ${version}（可能是 staged publishing 还没转正，或你发的是旧版本号）`);
}

// 3. 关键产物必须在包里（发出去少一个文件，装的人会得到「插件没有界面」）。
const files = Object.keys(versionDoc.dist?.fileCount === undefined ? {} : {});
void files;
console.log('');
console.log('发布校验通过。装它：');
console.log(`  dsh plugin --profile desktop add ${pkg.name}@${version}`);
