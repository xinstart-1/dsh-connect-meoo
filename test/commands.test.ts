/**
 * `/meoo` 斜杠命令的测试。
 *
 * 重点钉住三条：
 * 1. **`commands` 服务缺失时退化成「没有命令」，不抛** —— 命令是附加入口，
 *    不能让插件因为宿主没这个服务就挂载失败。
 * 2. 每个子命令都真的走 `runtime.run` / `runtime.status`，不自己造一套逻辑。
 * 3. 失败带上游原文（用户要能整段贴进 issue）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMMAND_NAME,
  registerMeooCommand,
  renderModels,
  renderStatus,
  type CommandDefinition,
  type CommandsLike,
} from '../src/host/commands.ts';
import type { StatusDocument } from '../src/host/status.ts';
import type { MeooRuntime } from '../src/host/runtime.ts';

/** 一份完整的假状态文档。 */
function doc(overrides: Partial<StatusDocument> = {}): StatusDocument {
  return {
    version: '0.0.1',
    login: { state: 'signed-in', source: 'oauth', name: 'tester', hasServiceAk: true, canLogin: true },
    points: { state: 'ok', available: 1234, consumed: 56 },
    projects: [],
    activeProject: 'proj-1',
    models: [
      { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_000_000, maxTokens: 128_000, vision: false, enabled: true },
      { id: 'qwen3-vl-plus', name: 'Qwen VL', contextWindow: 262_144, maxTokens: 32_768, vision: true, enabled: false },
    ],
    settings: { pollIntervalMs: 300_000, composerPill: true, sidebarPanel: false, disabledModels: [] },
    gateway: 'https://api.meoo.host/meoo-ai/compatible-mode/v1',
    readAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

/** 记录调用并返回预设结果的假 runtime。 */
function fakeRuntime(options: {
  status?: StatusDocument;
  results?: Record<string, unknown>;
}): { runtime: MeooRuntime; calls: Array<{ kind: string; payload: unknown }> } {
  const calls: Array<{ kind: string; payload: unknown }> = [];
  const runtime = {
    async status(force: boolean) {
      calls.push({ kind: 'status', payload: force });
      return options.status ?? doc();
    },
    async run(action: string, body: Record<string, unknown>) {
      calls.push({ kind: 'action', payload: { action, body } });
      return options.results?.[action] ?? { ok: true };
    },
  } as unknown as MeooRuntime;
  return { runtime, calls };
}

/** 注册命令并拿到它的定义。 */
function mount(options: Parameters<typeof fakeRuntime>[0]): {
  definition: CommandDefinition;
  calls: Array<{ kind: string; payload: unknown }>;
  disposed: () => boolean;
} {
  const { runtime, calls } = fakeRuntime(options);
  let captured: CommandDefinition | undefined;
  let wasDisposed = false;
  const commands: CommandsLike = {
    register(definition) {
      captured = definition;
      return () => {
        wasDisposed = true;
      };
    },
  };
  const dispose = registerMeooCommand(commands, runtime, () => undefined);
  assert.ok(captured !== undefined, '命令必须被注册');
  return { definition: captured, calls, disposed: () => wasDisposed || typeof dispose === 'function' };
}

/** 跑一次命令。 */
async function run(definition: CommandDefinition, rawInput: string): Promise<{ kind: string; text: string }> {
  return definition.handler({ rawInput });
}

test('commands 服务缺失时返回空 disposer，且不抛', () => {
  const warnings: string[] = [];
  const dispose = registerMeooCommand(undefined, {} as MeooRuntime, (message) => warnings.push(message));
  assert.equal(typeof dispose, 'function');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /commands 服务不可用/);
});

test('commands.register 抛错时不外泄（注册失败只记日志）', () => {
  const warnings: string[] = [];
  const broken: CommandsLike = {
    register() {
      throw new Error('宿主拒绝注册');
    },
  };
  const dispose = registerMeooCommand(broken, {} as MeooRuntime, (message) => warnings.push(message));
  assert.equal(typeof dispose, 'function');
  assert.match(warnings[0]!, /宿主拒绝注册/);
});

test('命令名与 input hint 正确', () => {
  const { definition } = mount({});
  assert.equal(definition.name, COMMAND_NAME);
  assert.equal(definition.name, 'meoo');
  assert.match(definition.input?.hint ?? '', /login/);
});

test('不带子命令 = 显示状态（并强制刷新）', async () => {
  const { definition, calls } = mount({});
  const result = await run(definition, '');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /已登录/);
  assert.match(result.text, /GLM-5\.2|模型/);
  // 强制刷新：用户敲命令就是想知道「现在」。
  assert.deepEqual(calls[0], { kind: 'status', payload: true });
});

test('status 子命令显示账号、项目、AK、积分、错误原文', async () => {
  const { definition } = mount({
    status: doc({ lastError: 'HTTP 500 upstream boom' }),
  });
  const result = await run(definition, 'status');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /账号: tester/);
  assert.match(result.text, /当前项目: proj-1/);
  assert.match(result.text, /项目服务 AK: 已就绪/);
  assert.match(result.text, /可用 1,234/);
  assert.match(result.text, /HTTP 500 upstream boom/, '错误原文必须原样带出');
});

test('未登录时状态文本说明未登录，而不是空白', async () => {
  const { definition } = mount({
    status: doc({
      login: { state: 'signed-out', source: 'none', hasServiceAk: false, canLogin: true },
      points: { state: 'unavailable' },
      activeProject: undefined,
    }),
  });
  const result = await run(definition, 'status');
  assert.match(result.text, /未登录/);
  assert.match(result.text, /项目服务 AK: 未解析/);
  assert.match(result.text, /暂时读不到/);
});

test('models 子命令列模型并标出启用/停用与图片能力', async () => {
  const { definition } = mount({});
  const result = await run(definition, 'models');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /glm-5\.2/);
  assert.match(result.text, /启用/);
  assert.match(result.text, /停用/, '被停用的模型要标出来');
  assert.match(result.text, /图片/, '多模态要标出来');
});

test('models 子命令在空目录时给下一步指引', async () => {
  const { definition } = mount({ status: doc({ models: [] }) });
  const result = await run(definition, 'models');
  assert.match(result.text, /\/meoo login/);
});

test('sync 子命令成功时报模型数', async () => {
  const { definition, calls } = mount({});
  const result = await run(definition, 'sync');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /2 个模型/);
  assert.deepEqual(calls[0], { kind: 'status', payload: true });
});

test('sync 子命令遇到 lastError 时返回 error 并带上原文', async () => {
  const { definition } = mount({ status: doc({ lastError: 'HTTP 401 invalid_token' }) });
  const result = await run(definition, 'sync');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /HTTP 401 invalid_token/);
});

test('login 子命令把授权 URL 交给用户（浏览器没弹出来时能手动开）', async () => {
  const { definition, calls } = mount({
    results: { login: { ok: true, url: 'https://meoo.com/oauth/authorize?x=1' } },
  });
  const result = await run(definition, 'login');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /https:\/\/meoo\.com\/oauth\/authorize/);
  assert.deepEqual(calls[0]?.payload, { action: 'login', body: {} });
});

test('login 失败时返回 error 并带上原因', async () => {
  const { definition } = mount({ results: { login: { ok: false, error: '端口被占' } } });
  const result = await run(definition, 'login');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /端口被占/);
});

test('project 子命令缺参数时给用法，不调 runtime', async () => {
  const { definition, calls } = mount({});
  const result = await run(definition, 'project');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /用法/);
  assert.equal(calls.length, 0, '缺参数时不该发动作');
});

test('project 子命令带上 urlId 时调动作', async () => {
  const { definition, calls } = mount({});
  const result = await run(definition, 'project proj-2');
  assert.equal(result.kind, 'success');
  assert.deepEqual(calls[0]?.payload, { action: 'project', body: { projectUrlId: 'proj-2' } });
});

test('key 子命令缺参数时给用法', async () => {
  const { definition, calls } = mount({});
  const result = await run(definition, 'key');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /meoo_project_service_v1/);
  assert.equal(calls.length, 0);
});

test('key 子命令校验失败时返回 error', async () => {
  const { definition } = mount({ results: { ak: { ok: false, error: '网关拒绝了这个 AK（HTTP 401）' } } });
  const result = await run(definition, 'key meoo_project_service_v1.bad');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /HTTP 401/);
});

test('key 子命令成功时提醒手填 AK 读不到积分', async () => {
  const { definition } = mount({ results: { ak: { ok: true, models: 9 } } });
  const result = await run(definition, 'key meoo_project_service_v1.good');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /9 个模型/);
  assert.match(result.text, /读不到积分/);
});

test('logout 子命令调动作', async () => {
  const { definition, calls } = mount({});
  const result = await run(definition, 'logout');
  assert.equal(result.kind, 'success');
  assert.deepEqual(calls[0]?.payload, { action: 'logout', body: {} });
});

test('未知子命令返回 error 并附状态（别让用户对着「未知」发愣）', async () => {
  const { definition } = mount({});
  const result = await run(definition, 'nope');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /未知子命令/);
  assert.match(result.text, /已登录/, '附一份状态让用户知道当前在哪');
});

test('runtime 抛错时命令转成 error 而不是让异常冒出去', async () => {
  const runtime = {
    async status() {
      throw new Error('上游炸了');
    },
    async run() {
      throw new Error('上游炸了');
    },
  } as unknown as MeooRuntime;
  let captured: CommandDefinition | undefined;
  registerMeooCommand(
    {
      register(definition) {
        captured = definition;
        return () => undefined;
      },
    },
    runtime,
    () => undefined,
  );
  const result = await run(captured!, 'sync');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /上游炸了/);
});

test('renderStatus 对缺失字段给「—」而不是 undefined', () => {
  const text = renderStatus(
    doc({
      login: { state: 'signed-out', source: 'none', hasServiceAk: false, canLogin: true },
      points: { state: 'unavailable' },
      activeProject: undefined,
      readAtMs: 0,
    }),
  );
  assert.equal(text.includes('undefined'), false, '不能把 undefined 打到界面上');
  assert.match(text, /—/);
});

test('renderModels 空目录时给指引而不是空串', () => {
  assert.match(renderModels(doc({ models: [] })), /还没有读到模型目录/);
});

test('/meoo apikey 无参数时给出用法提示', async () => {
  const { definition } = mount({});
  const result = await run(definition, 'apikey');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /meoo_ak_/, '要告诉用户去哪生成 meoo_ak_ 开头的 key');
});

test('/meoo apikey 成功时回报项目与模型数，并说明积分可读', async () => {
  const { definition, calls } = mount({ results: { apikey: { ok: true, project: 'p1', models: 9 } } });
  const result = await run(definition, 'apikey meoo_ak_test');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /p1/);
  assert.match(result.text, /9/);
  const call = calls.find(
    (entry) => entry.kind === 'action' && (entry.payload as { action: string }).action === 'apikey',
  );
  assert.ok(call !== undefined, '必须真的调 apikey 动作');
  assert.equal((call.payload as { body: { apiKey: string } }).body.apiKey, 'meoo_ak_test');
});
