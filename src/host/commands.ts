/**
 * `/meoo` 斜杠命令。
 *
 * 为什么要有它：卡片是**图形**入口，命令是**键盘**入口。用户在会话里正打着字，
 * 想切项目 / 重新同步 / 看状态时，不该被迫先去点设置面板再回来。
 *
 * 三条纪律（与卡片一致）：
 * 1. `commands` 服务是**软取**的 —— 没有它就退化成「没有命令」，不能因此让插件挂载失败。
 *    `/meoo` 是附加能力，不是承重结构。
 * 2. 命令只做**已有动作的另一个入口**，不新增任何绕过白名单的写操作。
 * 3. 失败返回 `kind: 'error'` 并把上游原文带上 —— 用户要能把那句话整段贴进 issue。
 *
 * @module dsh-connect-meoo/host/commands
 */

import { VERSION } from '../constants.ts';
import type { MeooRuntime } from './runtime.ts';
import type { StatusDocument } from './status.ts';

/** 命令名（不含斜杠）。 */
export const COMMAND_NAME = 'meoo';

/** `commands` 服务的最小形状（只用到 register）。 */
export interface CommandsLike {
  register(definition: CommandDefinition): () => void;
}

/** 命令返回值。 */
export interface CommandResult {
  kind: 'success' | 'error';
  text: string;
}

/** 命令调用现场（只用到这几个字段）。 */
export interface CommandInvocation {
  rawInput?: unknown;
  [key: string]: unknown;
}

/** 命令定义。 */
export interface CommandDefinition {
  name: string;
  description: string;
  input?: { hint?: string };
  handler: (invocation: CommandInvocation) => Promise<CommandResult> | CommandResult;
}

/** 数字千分位。 */
function num(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat('en-US').format(value)
    : '—';
}

/** 时间戳 → `YYYY-MM-DD HH:MM`。 */
function stamp(ms: number | undefined): string {
  if (typeof ms !== 'number' || ms <= 0) return '—';
  const date = new Date(ms);
  const pad = (n: number): string => (n < 10 ? '0' : '') + String(n);
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

/** 登录方式的中文标签。 */
function sourceLabel(source: string): string {
  if (source === 'oauth') return '浏览器授权';
  if (source === 'local') return '复用本机登录态';
  if (source === 'ak') return '手填项目服务 AK';
  return '无';
}

/**
 * 把状态文档渲染成一段可读文本。
 *
 * 只输出**事实**：不解释、不建议、不翻译上游错误原文。
 * @param doc - 状态文档。
 * @returns 多行文本。
 */
export function renderStatus(doc: StatusDocument): string {
  const lines: string[] = [];
  lines.push(`**Meoo 秒悟** v${doc.version}`);
  lines.push('');
  lines.push(`- 登录态: ${doc.login.state === 'signed-in' ? '已登录' : doc.login.state === 'expired' ? '已失效' : '未登录'}`);
  lines.push(`- 登录方式: ${sourceLabel(doc.login.source)}`);
  if (doc.login.name !== undefined) lines.push(`- 账号: ${doc.login.name}`);
  lines.push(`- 项目服务 AK: ${doc.login.hasServiceAk ? '已就绪' : '未解析'}`);
  lines.push(`- 当前项目: ${doc.activeProject ?? '未选中'}`);
  lines.push(`- 网关: ${doc.gateway}`);
  lines.push(`- 模型: ${String(doc.models.length)} 个（启用 ${String(doc.models.filter((model) => model.enabled).length)}）`);
  if (doc.points.state === 'ok') {
    lines.push(
      `- 积分: 可用 ${num(doc.points.available)}，已用 ${num(doc.points.consumed)}` +
        (doc.points.nextExpiry === undefined ? '' : `，最近 ${doc.points.nextExpiry} 到期`),
    );
  } else {
    lines.push(`- 积分: ${doc.points.state === 'expired' ? '登录态失效，读不到' : '暂时读不到'}`);
  }
  lines.push(`- 更新于: ${stamp(doc.readAtMs)}`);
  if (doc.lastError !== undefined) lines.push(`- 上次错误: ${doc.lastError}`);
  lines.push('');
  lines.push('用法: `/meoo login` 授权 · `/meoo sync` 重新同步 · `/meoo models` 列模型 · `/meoo project <urlId>` 换项目 · `/meoo key <ak>` 手填 AK · `/meoo logout` 退出');
  return lines.join('\n');
}

/** 模型清单文本。 */
export function renderModels(doc: StatusDocument): string {
  if (doc.models.length === 0) return '还没有读到模型目录。先 `/meoo login`，再 `/meoo sync`。';
  return doc.models
    .map((model) => {
      const flags = [model.enabled ? '启用' : '停用'];
      if (model.vision) flags.push('图片');
      return `- \`${model.id}\` — ${model.name}（${String(Math.round(model.contextWindow / 1000))}K，${flags.join(' / ')}）`;
    })
    .join('\n');
}

/**
 * 注册 `/meoo` 命令。
 *
 * `commands` 由调用方传入而不是内部查找：没有这个服务时应当退化成「没有命令」，
 * 而不是让整个插件挂载失败。
 *
 * @param commands - `commands` 服务（可能是 undefined）。
 * @param runtime - 运行时（所有动作都走它，与卡片共用同一套逻辑）。
 * @param warn - 诊断日志。
 * @returns disposer（没注册时是空函数）。
 */
export function registerMeooCommand(
  commands: CommandsLike | undefined,
  runtime: MeooRuntime,
  warn: (message: string) => void,
): () => void {
  if (commands === undefined || typeof commands.register !== 'function') {
    warn('commands 服务不可用，/meoo 命令未注册（卡片仍可用）');
    return () => undefined;
  }

  try {
    return commands.register({
      name: COMMAND_NAME,
      description:
        'Meoo 秒悟：查看状态、API Key 登录、浏览器授权、同步模型、换项目。不带子命令 = 显示状态。',
      input: { hint: '[status|apikey <meoo_ak_…>|login|sync|models|project <urlId>|key <ak>|logout]' },
      handler: async (invocation) => {
        const raw = typeof invocation.rawInput === 'string' ? invocation.rawInput.trim() : '';
        const [sub = 'status', ...rest] = raw.split(/\s+/);
        const argument = rest.join(' ').trim();

        try {
          switch (sub === '' ? 'status' : sub) {
            case 'status': {
              const doc = (await runtime.status(true)) as StatusDocument;
              return { kind: 'success', text: renderStatus(doc) };
            }

            case 'models': {
              const doc = (await runtime.status(false)) as StatusDocument;
              return { kind: 'success', text: renderModels(doc) };
            }

            case 'sync': {
              const doc = (await runtime.status(true)) as StatusDocument;
              if (doc.lastError !== undefined) {
                return {
                  kind: 'error',
                  text: `同步时上游报错（模型路由可能仍是上次的好数据）：\n${doc.lastError}`,
                };
              }
              return {
                kind: 'success',
                text:
                  `已同步：${String(doc.models.length)} 个模型` +
                  (doc.activeProject === undefined ? '' : `，项目 ${doc.activeProject}`) +
                  `。在输入框的模型选择器里选「Meoo 秒悟」即可使用。`,
              };
            }

            case 'login': {
              const result = (await runtime.run('login', {})) as {
                ok: boolean;
                url?: string;
                message?: string;
                error?: string;
              };
              if (result.ok !== true) {
                return { kind: 'error', text: `登录失败：${result.error ?? '未知原因'}` };
              }
              return {
                kind: 'success',
                text:
                  '已在浏览器打开 Meoo 授权页；点一次「授权」后会自动同步。\n' +
                  (result.url === undefined ? '' : `没弹出来就手动打开：\n${result.url}\n`) +
                  '\n完成后用 `/meoo status` 查看结果。',
              };
            }

            case 'project': {
              if (argument === '') {
                return { kind: 'error', text: '用法：`/meoo project <urlId>`（先 `/meoo status` 看可选项目）' };
              }
              const result = (await runtime.run('project', { projectUrlId: argument })) as {
                ok: boolean;
                error?: string;
              };
              if (result.ok !== true) {
                return { kind: 'error', text: `换项目失败：${result.error ?? '未知原因'}` };
              }
              return { kind: 'success', text: `已切到项目 ${argument}，项目服务 AK 已重新解析。` };
            }

            case 'apikey': {
              if (argument === '') {
                return {
                  kind: 'error',
                  text: '用法：`/meoo apikey meoo_ak_xxx`（在 meoo.com → 设置 → API 密钥 生成）',
                };
              }
              const result = (await runtime.run('apikey', { apiKey: argument })) as {
                ok: boolean;
                project?: string;
                models?: number;
                error?: string;
              };
              if (result.ok !== true) {
                return { kind: 'error', text: `API Key 保存失败：${result.error ?? '未知原因'}` };
              }
              return {
                kind: 'success',
                text:
                  `已保存 API Key，项目 ${String(result.project ?? '-')}，` +
                  `网关返回 ${String(result.models ?? 0)} 个模型。积分账户可读。`,
              };
            }

            case 'key': {
              if (argument === '') {
                return {
                  kind: 'error',
                  text: '用法：`/meoo key meoo_project_service_v1.xxx`（在 meoo.com 项目 → 云服务里复制）',
                };
              }
              const result = (await runtime.run('ak', { serviceAk: argument })) as {
                ok: boolean;
                models?: number;
                error?: string;
              };
              if (result.ok !== true) {
                return { kind: 'error', text: `AK 校验失败：${result.error ?? '未知原因'}` };
              }
              return {
                kind: 'success',
                text: `已保存项目服务 AK，网关返回 ${String(result.models ?? 0)} 个模型。注意：手填 AK 读不到积分账户。`,
              };
            }

            case 'logout': {
              await runtime.run('logout', {});
              return { kind: 'success', text: '已清除本插件保存的登录态（模型路由保留）。' };
            }

            default: {
              const doc = (await runtime.status(false)) as StatusDocument;
              return {
                kind: 'error',
                text: `未知子命令：\`${sub}\`\n\n${renderStatus(doc)}`,
              };
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { kind: 'error', text: `Meoo: ${message}` };
        }
      },
    });
  } catch (error) {
    warn(`/meoo 命令注册失败：${error instanceof Error ? error.message : String(error)}`);
    return () => undefined;
  }
}

/** 命令版本（供诊断显示）。 */
export const COMMAND_VERSION = VERSION;
