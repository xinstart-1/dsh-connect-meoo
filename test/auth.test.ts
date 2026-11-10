/**
 * 登录态存储的测试。
 *
 * 重点钉住三条纪律：
 * 1. **严格只读**复用别人的登录态文件（一个字节都不写回）；
 * 2. 写自己的文件时**保留不认识的字段**（降级不丢数据）；
 * 3. 兼容 `dsh-meoo-connect` 与 `meoo-proxy` 两套字段名。
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  EMPTY_AUTH,
  authFile,
  clientIdFor,
  normalizeAuth,
  proxyConfigFile,
  readAuth,
  readLocalLogin,
  writeAuth,
} from '../src/credentials/store.ts';

const temporaryDirs: string[] = [];

async function freshHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-meoo-auth-'));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test('authFile / proxyConfigFile 跟随环境变量', () => {
  const env = { DSH_HOME: 'C:/dsh', MEOO_PROXY_HOME: 'C:/proxy' };
  assert.equal(authFile(env), join('C:/dsh', 'meoo', 'state.json'));
  assert.equal(proxyConfigFile(env), join('C:/proxy', 'config.json'));
});

test('clientIdFor 按站点挑客户端 id', () => {
  assert.equal(clientIdFor('https://meoo.com'), 'meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh');
  assert.equal(clientIdFor('https://meoo.com/'), 'meoo_app_tdWlRbpvAxN1EjmZ8XICxdTh');
  // 其它站点（测试环境）用测试 id。
  assert.equal(clientIdFor('https://staging.example.com'), 'meoo_app_SFNvmHUFNePxyyfGjCd9hyaE');
  // 坏 URL 也不能抛。
  assert.equal(clientIdFor('not a url'), 'meoo_app_SFNvmHUFNePxyyfGjCd9hyaE');
});

test('normalizeAuth 兼容 dsh-meoo-connect 的字段名', () => {
  const auth = normalizeAuth({
    apiBaseUrl: 'https://meoo.com',
    accessToken: 'at',
    refreshToken: 'rt',
    accessExpiresAt: 12345,
    username: 'someone',
    projectUrlId: 'p1',
    serviceAk: 'meoo_project_service_v1.abc',
    serviceAkProjectId: 'p1',
  });
  assert.equal(auth.apiBaseUrl, 'https://meoo.com');
  assert.equal(auth.accessToken, 'at');
  assert.equal(auth.refreshToken, 'rt');
  assert.equal(auth.accessExpiresAt, 12345);
  assert.equal(auth.username, 'someone');
  assert.equal(auth.serviceAk, 'meoo_project_service_v1.abc');
});

test('normalizeAuth 把空串归一成 null', () => {
  const auth = normalizeAuth({ accessToken: '  ', refreshToken: '', username: null });
  assert.equal(auth.accessToken, null);
  assert.equal(auth.refreshToken, null);
  assert.equal(auth.username, null);
  // apiBaseUrl 缺失时回落到生产站点。
  assert.equal(auth.apiBaseUrl, 'https://meoo.com');
});

test('normalizeAuth 对非对象返回空登录态', () => {
  for (const raw of [null, undefined, 42, 'x', []]) {
    const auth = normalizeAuth(raw);
    assert.equal(auth.apiBaseUrl, EMPTY_AUTH.apiBaseUrl);
    // EMPTY_AUTH 里没有写 accessToken 这个键，读出来是 undefined（不是 null）。
    assert.equal(auth.accessToken ?? null, null);
  }
});

test('readAuth 在文件不存在时返回空登录态', async () => {
  const home = await freshHome();
  const auth = await readAuth({ DSH_HOME: home });
  // 文件不存在时返回 EMPTY_AUTH 的副本：token 键不存在，读出来是 undefined。
  assert.equal(auth.accessToken ?? null, null);
  assert.equal(auth.apiBaseUrl, 'https://meoo.com');
});

test('writeAuth 保留文件里不认识的字段', async () => {
  const home = await freshHome();
  const env = { DSH_HOME: home };
  const file = authFile(env);
  await mkdir(join(home, 'meoo'), { recursive: true });
  // 模拟「新版本写过、我们又降级回来」的文件。
  await writeFile(file, JSON.stringify({ futureField: 'keep-me', refreshToken: 'old' }), 'utf8');

  await writeAuth({ apiBaseUrl: 'https://meoo.com', refreshToken: 'new' }, env);

  const parsed = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
  assert.equal(parsed.futureField, 'keep-me', '不认识的字段必须原样保留');
  assert.equal(parsed.refreshToken, 'new');
});

test('readLocalLogin 优先读自己的文件，缺的字段用 meoo-proxy 的填', async () => {
  const home = await freshHome();
  const proxyHome = join(home, 'proxy');
  await mkdir(join(home, 'meoo'), { recursive: true });
  await mkdir(proxyHome, { recursive: true });

  await writeFile(
    authFile({ DSH_HOME: home }),
    JSON.stringify({ apiBaseUrl: 'https://meoo.com', refreshToken: 'own-refresh' }),
    'utf8',
  );
  await writeFile(
    proxyConfigFile({ DSH_HOME: home, MEOO_PROXY_HOME: proxyHome }),
    JSON.stringify({ serviceAk: 'meoo_project_service_v1.proxy', projectUrlId: 'p-proxy' }),
    'utf8',
  );

  const merged = await readLocalLogin({ DSH_HOME: home, MEOO_PROXY_HOME: proxyHome });
  assert.ok(merged !== undefined);
  assert.equal(merged.refreshToken, 'own-refresh', '自己的文件优先');
  assert.equal(merged.serviceAk, 'meoo_project_service_v1.proxy', '缺的字段从 proxy 补');
  assert.equal(merged.projectUrlId, 'p-proxy');
});

test('readLocalLogin 在两处都没有时返回 undefined', async () => {
  const home = await freshHome();
  const merged = await readLocalLogin({ DSH_HOME: home, MEOO_PROXY_HOME: join(home, 'nope') });
  assert.equal(merged, undefined);
});

test('readLocalLogin 严格只读：不改动别人的文件', async () => {
  const home = await freshHome();
  const proxyHome = join(home, 'proxy');
  await mkdir(proxyHome, { recursive: true });
  const proxyFile = proxyConfigFile({ DSH_HOME: home, MEOO_PROXY_HOME: proxyHome });
  const original = JSON.stringify({ refreshToken: 'proxy-rt', serviceAk: 'ak' });
  await writeFile(proxyFile, original, 'utf8');

  await readLocalLogin({ DSH_HOME: home, MEOO_PROXY_HOME: proxyHome });

  assert.equal(await readFile(proxyFile, 'utf8'), original, 'meoo-proxy 的文件必须逐字节不变');
});

test('readLocalLogin 里既没有 refresh 也没有 AK 时返回 undefined', async () => {
  const home = await freshHome();
  await mkdir(join(home, 'meoo'), { recursive: true });
  await writeFile(authFile({ DSH_HOME: home }), JSON.stringify({ username: 'only-name' }), 'utf8');
  const merged = await readLocalLogin({ DSH_HOME: home, MEOO_PROXY_HOME: join(home, 'nope') });
  assert.equal(merged, undefined);
});
