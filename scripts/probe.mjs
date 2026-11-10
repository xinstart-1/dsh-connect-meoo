/**
 * 现场探测：这台机器现在能不能用秒悟。
 *
 * 不登录、不花积分，只回答四个问题：
 * 1. Meoo 三个端点通不通（OAuth / 控制面 / 网关）；
 * 2. 本机有没有现成的 Meoo 登录态（dsh-meoo-connect / meoo-proxy）；
 * 3. 有登录态时，AK 与模型目录能不能解析出来；
 * 4. 插件当前会报什么（未登录时应该是「未登录」，不是「插件坏了」）。
 *
 * 用法：`node scripts/probe.mjs`
 */

import { readFile } from 'node:fs/promises';
import { GATEWAY_BASE, API_BASE, IDENTITY_PATH, POINTS_PATH, PROJECTS_PATH } from '../src/constants.ts';
import { authFile, proxyConfigFile, readLocalLogin } from '../src/credentials/store.ts';
import { fetchGatewayModels, fetchPoints, fetchIdentity, resolveServiceAk } from '../src/protocol/client.ts';

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : '--  '} ${name}${detail === undefined ? '' : `：${detail}`}`);
}

/** 探一个端点，只关心「通不通」与状态码。 */
async function probeEndpoint(label, url, headers = {}) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    const text = (await res.text()).slice(0, 200);
    // 401 也算「端点存在」：请求已经打到业务层。
    record(label, true, `HTTP ${res.status}${text === '' ? '' : ` ${text}`}`);
    return res.status;
  } catch (error) {
    record(label, false, error instanceof Error ? error.message : String(error));
    return 0;
  }
}

console.log('=== 1. 端点可达性 ===');
await probeEndpoint('OAuth 授权页', `${API_BASE}/oauth/authorize?client_id=x&response_type=code`);
await probeEndpoint('控制面 identity', `${API_BASE}${IDENTITY_PATH}`);
await probeEndpoint('控制面 points', `${API_BASE}${POINTS_PATH}`);
await probeEndpoint('控制面 projects', `${API_BASE}${PROJECTS_PATH}`);
await probeEndpoint('网关 /models', `${GATEWAY_BASE}/models`);

console.log('\n=== 2. 本机登录态 ===');
const ownFile = authFile();
const proxyFile = proxyConfigFile();
const exists = async (file) => {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
};
record('本插件登录态文件', await exists(ownFile), ownFile);
record('meoo-proxy 配置', await exists(proxyFile), proxyFile);

const local = await readLocalLogin();
record('可用登录态', local !== undefined, local === undefined ? '没有' : `来源 ${local.serviceAk ? 'AK' : 'token'}`);

console.log('\n=== 3. 登录态可用性 ===');
if (local === undefined) {
  console.log('--  未登录：跳过 AK / 目录 / 积分探测。');
  console.log('    下一步：在 DSH 设置 → 秒悟 里点「登录秒悟」，浏览器里点一次「授权」。');
} else {
  try {
    const me = await fetchIdentity(local);
    record('账号身份', true, `${me.name ?? '?'} (${me.userId ?? '?'})`);
  } catch (error) {
    record('账号身份', false, error instanceof Error ? error.message : String(error));
  }
  try {
    const projectUrlId = local.projectUrlId ?? (await fetchIdentity(local)).projectUrlId;
    if (projectUrlId === undefined || projectUrlId === '') {
      record('项目服务 AK', false, '账号没有默认项目，需要先指定项目');
    } else {
      const ak = await resolveServiceAk(local, projectUrlId);
      record('项目服务 AK', true, `${ak.slice(0, 24)}…（项目 ${projectUrlId}）`);
      const models = await fetchGatewayModels(ak);
      record('模型目录', models.length > 0, `${models.length} 个：${models.map((m) => m.id).join(', ')}`);
    }
  } catch (error) {
    record('项目服务 AK', false, error instanceof Error ? error.message : String(error));
  }
  try {
    const points = await fetchPoints(local);
    record('积分', true, `可用 ${points.available}，已用 ${points.consumed}`);
  } catch (error) {
    record('积分', false, error instanceof Error ? error.message : String(error));
  }
}

console.log('\n=== 结论 ===');
const failed = results.filter((entry) => !entry.ok);
if (failed.length === 0) {
  console.log('全部通过。');
} else {
  console.log(`${failed.length} 项待处理：${failed.map((entry) => entry.name).join(', ')}`);
  console.log('未登录时的「--」是预期行为，不是故障。');
}
