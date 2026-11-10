/**
 * 运行时测试：状态文档的组装、缓存语义、动作。
 *
 * 网络全部用假 `fetch` 替换。重点钉住两条纪律：
 * 1. **网络失败不清空上一次的好数据**（宁可是旧读数，也不要变「未登录」）；
 * 2. **不做乐观更新**（动作后重拉上游）。
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { MeooRuntime } from '../src/host/runtime.ts';
import { DEFAULT_STATE, type MeooPluginState } from '../src/state.ts';
import { authFile } from '../src/credentials/store.ts';
import { mkdir, writeFile } from 'node:fs/promises';

const realFetch = globalThis.fetch;
const temporaryDirs: string[] = [];

afterEach(async () => {
  globalThis.fetch = realFetch;
  await Promise.all(temporaryDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-meoo-runtime-'));
  temporaryDirs.push(dir);
  return dir;
}

/** 装一个按路径作答的假 fetch。 */
function stubFetch(routes: Array<{ match: (url: string) => boolean; status?: number; body: unknown }>): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    for (const route of routes) {
      if (route.match(url)) {
        return new Response(JSON.stringify(route.body), {
          status: route.status ?? 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ detail: 'no route' }), { status: 404 });
  }) as typeof fetch;
}

/** 造一个已登录且 AK 就绪的运行时。 */
async function makeRuntime(options: {
  home: string;
  state?: Partial<MeooPluginState>;
  manualAk?: string;
  /** 假浏览器启动器：记录 URL，并决定「有没有打开」。 */
  openBrowser?: (url: string) => boolean | void;
}): Promise<{ runtime: MeooRuntime; saved: MeooPluginState[] }> {
  const saved: MeooPluginState[] = [];
  let state: MeooPluginState = { ...DEFAULT_STATE, ...options.state };
  const runtime = new MeooRuntime({
    state: async () => state,
    saveState: async (patch) => {
      state = { ...state, ...patch };
      saved.push(state);
      return state;
    },
    warn: () => undefined,
    manualServiceAk: () => options.manualAk ?? '',
    explicitProject: () => '',
    gatewayBaseUrl: () => '',
    reuseLocalLogin: () => true,
    openBrowser: options.openBrowser ?? (() => undefined),
  });
  runtime.rememberStateSync(state);
  return { runtime, saved };
}

/** 写一份登录态到临时 home。 */
async function writeLogin(home: string): Promise<void> {
  await mkdir(join(home, 'meoo'), { recursive: true });
  await writeFile(
    authFile({ DSH_HOME: home }),
    JSON.stringify({
      apiBaseUrl: 'https://meoo.com',
      accessToken: 'at',
      refreshToken: 'rt',
      accessExpiresAt: Date.now() + 3_600_000,
      username: 'tester',
      projectUrlId: 'proj-1',
      serviceAk: 'meoo_project_service_v1.test',
      serviceAkProjectId: 'proj-1',
    }),
    'utf8',
  );
}

test('没有登录态时状态文档是 signed-out，但目录仍有静态兜底', async () => {
  const home = await freshHome();
  const { runtime } = await makeRuntime({ home });
  const doc = await runtime.status(true);
  assert.equal(doc.login.state, 'signed-out');
  assert.equal(doc.login.source, 'none');
  assert.equal(doc.login.hasServiceAk, false);
  // 关键：目录不为空 —— 空列表会让模型选择器整组消失，而它不会自己变好。
  assert.ok(doc.models.length > 0, '未登录时也要有静态兜底目录');
  assert.equal(doc.points.state, 'unavailable');
});

test('登录态可用时状态文档带积分、目录与项目', async () => {
  const home = await freshHome();
  await writeLogin(home);
  process.env.DSH_HOME = home;
  try {
    stubFetch([
      { match: (url) => url.includes('/account/points'), body: { account: { availableBalance: 888, totalConsumed: 12 } } },
      { match: (url) => url.includes('/projects?'), body: { list: [{ url_id: 'proj-1', name: '我的项目' }] } },
      { match: (url) => url.endsWith('/models'), body: { models: [{ id: 'glm-5.2' }, { id: 'qwen3.8-flash' }] } },
    ]);
    const { runtime } = await makeRuntime({ home });
    const doc = await runtime.status(true);

    assert.equal(doc.login.state, 'signed-in');
    assert.equal(doc.login.hasServiceAk, true);
    assert.equal(doc.login.name, 'tester');
    assert.equal(doc.points.state, 'ok');
    assert.equal(doc.points.available, 888);
    assert.deepEqual(
      doc.models.map((model) => model.id),
      ['glm-5.2', 'qwen3.8-flash'],
    );
    assert.equal(doc.activeProject, 'proj-1');
  } finally {
    delete process.env.DSH_HOME;
  }
});

test('上游失败不清空上一次的好数据，只记 lastError', async () => {
  const home = await freshHome();
  await writeLogin(home);
  process.env.DSH_HOME = home;
  try {
    // 第一轮：全部正常。
    stubFetch([
      { match: (url) => url.includes('/account/points'), body: { account: { availableBalance: 500 } } },
      { match: (url) => url.endsWith('/models'), body: { models: [{ id: 'glm-5.2' }] } },
    ]);
    const { runtime } = await makeRuntime({ home });
    const first = await runtime.status(true);
    assert.equal(first.points.available, 500);

    // 第二轮：积分接口 500。
    stubFetch([
      { match: (url) => url.includes('/account/points'), status: 500, body: { detail: 'upstream boom' } },
      { match: (url) => url.endsWith('/models'), body: { models: [{ id: 'glm-5.2' }] } },
    ]);
    const second = await runtime.status(true);

    assert.equal(second.points.state, 'ok', '积分仍然是上次的好读数');
    assert.equal(second.points.available, 500, '数值不该被清空');
    assert.match(String(second.lastError), /upstream boom/, '错误要如实记下来');
    assert.equal(second.login.state, 'signed-in', '一次 500 不该变成「未登录」');
  } finally {
    delete process.env.DSH_HOME;
  }
});

test('目录里的模型会按 disabledModels 过滤出 enabled=false', async () => {
  const home = await freshHome();
  await writeLogin(home);
  process.env.DSH_HOME = home;
  try {
    stubFetch([
      { match: (url) => url.endsWith('/models'), body: { models: [{ id: 'glm-5.2' }, { id: 'qwen3.8-flash' }] } },
    ]);
    const { runtime } = await makeRuntime({ home, state: { disabledModels: ['glm-5.2'] } });
    const doc = await runtime.status(true);
    const byId = new Map(doc.models.map((model) => [model.id, model]));
    assert.equal(byId.get('glm-5.2')?.enabled, false);
    assert.equal(byId.get('qwen3.8-flash')?.enabled, true);
  } finally {
    delete process.env.DSH_HOME;
  }
});

test('settings 动作写状态并返回新值', async () => {
  const home = await freshHome();
  const { runtime, saved } = await makeRuntime({ home });
  const result = (await runtime.run('settings', { composerPill: false, sidebarPanel: true })) as {
    ok: boolean;
    settings: MeooPluginState;
  };
  assert.equal(result.ok, true);
  assert.equal(result.settings.composerPill, false);
  assert.equal(result.settings.sidebarPanel, true);
  assert.ok(saved.length > 0, '必须真的调用 saveState');
});

test('settings 动作只接受已知字段类型，别的一律忽略', async () => {
  const home = await freshHome();
  const { runtime } = await makeRuntime({ home });
  const result = (await runtime.run('settings', {
    pollIntervalMs: 600_000,
    composerPill: 'yes', // 不是布尔：忽略
    disabledModels: ['a', 42, 'b'],
  })) as { ok: boolean; settings: MeooPluginState };
  assert.equal(result.settings.pollIntervalMs, 600_000);
  assert.equal(result.settings.composerPill, DEFAULT_STATE.composerPill, '非布尔值被忽略');
  assert.deepEqual(result.settings.disabledModels, ['a', 'b'], '非字符串项被丢掉');
});

test('未知动作返回 ok:false 而不是抛', async () => {
  const home = await freshHome();
  const { runtime } = await makeRuntime({ home });
  const result = (await runtime.run('nope' as never, {})) as { ok: boolean; error: string };
  assert.equal(result.ok, false);
  assert.match(result.error, /未知操作/);
});

test('手填 AK 会被校验：坏 AK 不落盘', async () => {
  const home = await freshHome();
  process.env.DSH_HOME = home;
  try {
    stubFetch([{ match: (url) => url.endsWith('/models'), status: 401, body: { error: { message: 'bad' } } }]);
    const { runtime } = await makeRuntime({ home });
    const result = (await runtime.run('ak', { serviceAk: 'meoo_project_service_v1.bad' })) as {
      ok: boolean;
      error: string;
    };
    assert.equal(result.ok, false);
    assert.match(result.error, /拒绝|401/);
  } finally {
    delete process.env.DSH_HOME;
  }
});

test('手填 AK 校验通过后落盘并立刻可用', async () => {
  const home = await freshHome();
  process.env.DSH_HOME = home;
  try {
    stubFetch([{ match: (url) => url.endsWith('/models'), body: { models: [{ id: 'glm-5.2' }] } }]);
    const { runtime } = await makeRuntime({ home });
    const result = (await runtime.run('ak', { serviceAk: 'meoo_project_service_v1.good' })) as {
      ok: boolean;
      models: number;
    };
    assert.equal(result.ok, true);
    assert.equal(result.models, 1);
  } finally {
    delete process.env.DSH_HOME;
  }
});

test('换项目会清掉旧 AK 并重新解析', async () => {
  const home = await freshHome();
  await writeLogin(home);
  process.env.DSH_HOME = home;
  try {
    stubFetch([
      { match: (url) => url.includes('/cloud/environment'), body: { meooProjectApiKey: 'meoo_project_service_v1.new' } },
      { match: (url) => url.endsWith('/models'), body: { models: [{ id: 'glm-5.2' }] } },
    ]);
    const { runtime } = await makeRuntime({ home });
    const result = (await runtime.run('project', { projectUrlId: 'proj-2' })) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(runtime.currentAuth().projectUrlId, 'proj-2');
    assert.equal(runtime.currentAuth().serviceAk, 'meoo_project_service_v1.new', 'AK 必须按新项目重取');
  } finally {
    delete process.env.DSH_HOME;
  }
});

test('logout 清登录态但不抛', async () => {
  const home = await freshHome();
  await writeLogin(home);
  process.env.DSH_HOME = home;
  try {
    const { runtime } = await makeRuntime({ home });
    await runtime.loadAuth();
    const result = (await runtime.run('logout', {})) as { ok: boolean };
    assert.equal(result.ok, true);
    assert.equal(runtime.currentAuth().accessToken, null);
  } finally {
    delete process.env.DSH_HOME;
  }
});

test('手填 AK 时积分显示 unavailable（上游读不到），不当成 0', async () => {
  const home = await freshHome();
  process.env.DSH_HOME = home;
  try {
    stubFetch([{ match: (url) => url.endsWith('/models'), body: { models: [{ id: 'glm-5.2' }] } }]);
    const { runtime } = await makeRuntime({ home, manualAk: 'meoo_project_service_v1.manual' });
    const doc = await runtime.status(true);
    assert.equal(doc.login.state, 'signed-in');
    assert.equal(doc.login.source, 'ak');
    // 「不知道」不能变成「0 积分」。
    assert.equal(doc.points.state, 'unavailable');
    assert.equal(doc.points.available, undefined);
  } finally {
    delete process.env.DSH_HOME;
  }
});

// ---------------------------------------------------------------------------
// 登录失败必须能被界面看见（上一版只写 console，用户看到的是「点了没反应」）。
// ---------------------------------------------------------------------------

test('登录在途时状态文档带 pending 与授权页 URL', async () => {
  const opened: string[] = [];
  const { runtime } = await makeRuntime({
    home: await freshHome(),
    openBrowser: (url: string) => {
      opened.push(url);
      return true;
    },
  });
  const result = (await runtime.run('login', {})) as { ok: boolean; url?: string; opened?: boolean };
  assert.equal(result.ok, true);
  assert.ok(typeof result.url === 'string' && result.url.includes('oauth/authorize'));
  assert.equal(opened.length, 1, '必须真的去拉浏览器一次');

  const doc = await runtime.status(true);
  assert.equal(doc.login.pending, true, '在等授权时必须告诉界面');
  assert.equal(doc.login.authorizeUrl, result.url, 'URL 要回到状态文档，用户才能手动打开');

  runtime.dispose();
});

test('浏览器拉不起来时动作结果说清「请手动打开」，不谎称已打开', async () => {
  const { runtime } = await makeRuntime({ home: await freshHome(), openBrowser: () => false });
  const result = (await runtime.run('login', {})) as { ok: boolean; opened?: boolean; message?: string };
  assert.equal(result.ok, true);
  assert.equal(result.opened, false);
  assert.match(String(result.message), /手动打开/);
  runtime.dispose();
});

test('已有在途登录时不回死路，而是把同一个 URL 再给一次', async () => {
  const { runtime } = await makeRuntime({ home: await freshHome(), openBrowser: () => true });
  const first = (await runtime.run('login', {})) as { url?: string };
  const second = (await runtime.run('login', {})) as { ok: boolean; alreadyPending?: boolean; url?: string };
  assert.equal(second.ok, true, '不能返回 ok:false 把用户堵死');
  assert.equal(second.alreadyPending, true);
  assert.equal(second.url, first.url, '同一次登录只能有一个回调端口');
  runtime.dispose();
});

test('没有在途登录时提交授权码会明确报错，而不是静默吞掉', async () => {
  const { runtime } = await makeRuntime({ home: await freshHome() });
  const result = (await runtime.run('login-code', { code: 'abc' })) as { ok: boolean; error?: string };
  assert.equal(result.ok, false);
  assert.match(String(result.error), /先点「登录秒悟」/);
  runtime.dispose();
});

test('在途登录时提交回调地址会被接受（走手动兜底）', async () => {
  const { runtime } = await makeRuntime({ home: await freshHome(), openBrowser: () => true });
  await runtime.run('login', {});
  const result = (await runtime.run('login-code', {
    code: 'http://127.0.0.1:1234/oauth/callback?state=x&code=manual-code',
  })) as { ok: boolean };
  assert.equal(result.ok, true, '整条回调地址必须能被接受');
  runtime.dispose();
});

test('restart 会丢弃在途登录并给出新的授权 URL（否则用户被锁到超时）', async () => {
  const { runtime } = await makeRuntime({ home: await freshHome(), openBrowser: () => true });
  const first = (await runtime.run('login', {})) as { url?: string };
  const restarted = (await runtime.run('login', { restart: true })) as {
    ok: boolean;
    url?: string;
    alreadyPending?: boolean;
  };
  assert.equal(restarted.ok, true);
  assert.equal(restarted.alreadyPending, undefined, 'restart 之后不该再是「已有一个在等」');
  assert.notEqual(restarted.url, first.url, '新的一次登录必须是新的 state 与回调端口');
  runtime.dispose();
});

test('旧会话被 restart 取代后，它的收尾不能清掉新会话的状态', async () => {
  const { runtime } = await makeRuntime({ home: await freshHome(), openBrowser: () => true });
  await runtime.run('login', {});
  const fresh = (await runtime.run('login', { restart: true })) as { url?: string };
  // 等旧会话的 finally 有机会跑（它被 cancel 后会 reject，链尾的 finally 就是缺陷点）。
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const doc = await runtime.status(true);
  assert.equal(doc.login.pending, true, '新会话必须仍然显示「在等授权」');
  assert.equal(doc.login.authorizeUrl, fresh.url, '界面上的 URL 必须还是新会话那一条');
  runtime.dispose();
});

// ---------------------------------------------------------------------------
// API Key 路径：一个 key 走完全程（身份 → 项目 → 积分 → 项目服务 AK → 目录）。
// 这是本插件成本最低的登录方式，比浏览器授权还省事。
// ---------------------------------------------------------------------------

test('apikey 动作：用控制面 API Key 自动换出项目服务 AK 并读积分', async () => {
  const home = await freshHome();
  process.env.DSH_HOME = home;
  try {
    stubFetch([
      { match: (url) => url.includes('/account/identity'), body: { success: true, data: { name: '幸鑫', user_id: 'u1' } } },
      { match: (url) => url.includes('/account/points'), body: { success: true, data: { account: { availableBalance: 8990, totalConsumed: 10 } } } },
      { match: (url) => url.includes('/projects') && url.includes('/cloud/environment'), body: { success: true, data: { enabled: true, meooProjectApiKey: 'meoo_project_service_v1.p1.1.1.sig' } } },
      // 项目列表实际是 `/projects?page_size=50`：用 endsWith('/projects') 会匹配不到。
      { match: (url) => url.includes('/projects') && !url.includes('/cloud'), body: { success: true, data: { list: [{ url_id: 'p1', name: '项目一' }] } } },
      { match: (url) => url.endsWith('/models'), body: { models: ['glm-5.2', 'qwen3.8-flash'] } },
    ]);
    const { runtime } = await makeRuntime({ home });
    const result = (await runtime.run('apikey', { apiKey: 'meoo_ak_test_key' })) as {
      ok: boolean;
      project?: string;
      models?: number;
    };
    assert.equal(result.ok, true, 'API Key 有效时必须成功');
    assert.equal(result.project, 'p1');
    assert.equal(result.models, 2);

    const doc = await runtime.status(true);
    assert.equal(doc.login.state, 'signed-in');
    assert.equal(doc.login.source, 'apikey', '来源必须标成 apikey');
    assert.equal(doc.login.name, '幸鑫');
    assert.equal(doc.login.hasServiceAk, true);
    assert.equal(doc.points.state, 'ok');
    assert.equal(doc.points.available, 8990, 'API Key 能读积分（项目服务 AK 读不到）');
    runtime.dispose();
  } finally {
    delete process.env.DSH_HOME;
  }
});

test('apikey 动作拒绝项目服务 AK 并说清该填哪种', async () => {
  const { runtime } = await makeRuntime({ home: await freshHome() });
  const result = (await runtime.run('apikey', { apiKey: 'meoo_project_service_v1.x' })) as {
    ok: boolean;
    error?: string;
  };
  assert.equal(result.ok, false);
  assert.match(String(result.error), /meoo_ak_/, '必须告诉用户该填 meoo_ak_ 开头的');
  runtime.dispose();
});

test('apikey 动作拒绝乱填的前缀，且不写坏已有登录态', async () => {
  const { runtime } = await makeRuntime({ home: await freshHome() });
  const result = (await runtime.run('apikey', { apiKey: 'not-a-key' })) as { ok: boolean };
  assert.equal(result.ok, false);
  const doc = await runtime.status(true);
  assert.equal(doc.login.state, 'signed-out', '失败不能把状态弄成已登录');
  runtime.dispose();
});
