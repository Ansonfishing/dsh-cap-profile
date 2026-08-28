/**
 * dsh-cap-profile — 模型能力画像(node 半)
 *
 * 数据源(DESIGN.md §3): ~/.dsh/sessions/<cwd目录>/<uuid>/session.jsonl.zstd
 *   request/header → header.config.{provider,model}  模型归属(每会话必带)
 *   user/message   → data.content[].text             任务意图
 *   tool/call      → data.name + data.arguments      工具调用
 *   tool/result    → message.content[].isError       成败判据
 *
 * 数据通道: 同源路由 GET /capability-profile(dsh-web-review 模式)——
 *   宿主侧直接读文件系统,无 live agent 依赖,冷会话可用。
 *   (否决 remote.commands 通道: 需目标实例上有 live agent,冷会话失败;
 *    且 commands/execute 契约要求 3 业务参数 (sessionId, line, images[]),
 *    dsh-ca-ref 只传 2 个,其面板从未真正加载过数据。)
 *
 * 安全纪律(照搬 dsh-web-review handler 模式):
 *   自定义 client header + Origin 必须等于 host + 严格 JSON,无 CORS。
 *
 * P1: 真实聚合(lib/analyzer.js 扫描 ~/.dsh/sessions,后台扫描+增量缓存);
 *     尚无 live 数据时回退固定 mock 文档(client 显示「示例数据」徽章)。
 *
 * @module dsh-cap-profile
 */
import os from "node:os";
import path from "node:path";
import { ProfileStore } from "./lib/analyzer.js";

export const name = "dsh-cap-profile";
export const inject = ["webServer"];

/** sessions 根目录:env 覆盖(测试用),默认 ~/.dsh/sessions。apply 时读取。 */
function defaultSessionsRoot() {
  const env = process.env.DSH_CAP_PROFILE_SESSIONS;
  return env ? path.resolve(env) : path.join(os.homedir(), ".dsh", "sessions");
}

const PROFILE_PATH = "/capability-profile";
const CLIENT_HEADER = "x-dsh-cap-profile-client";
const CLIENT_HEADER_VALUE = "v1";

/**
 * P0 mock 文档。模型 id 格式与 P1 一致: `${providerId} / ${modelId}`。
 * 数值是示例值,仅用于链路验证;P1 由 session 扫描真实产出。
 */
function summaryPayload() {
  return {
    source: "mock",
    generatedAt: new Date().toISOString(),
    note: "P0 示例数据 — P1 起由 ~/.dsh/sessions 真实聚合替换",
    models: [
      {
        id: "local-a / Demo-VL-35B-A3B",
        sessions: 412,
        toolCalls: 5820,
        toolErrors: 312,
        errorRate: 0.054,
        topTools: [
          { tool: "bash", calls: 2140, errors: 122 },
          { tool: "read", calls: 1310, errors: 4 },
          { tool: "edit", calls: 860, errors: 31 },
          { tool: "subagent", calls: 420, errors: 12 },
          { tool: "web_search", calls: 380, errors: 96 },
        ],
        topErrors: [
          { signature: "web_search: API key invalid (502)", count: 96 },
          { signature: "bash: [exit code: 137] OOM", count: 41 },
          { signature: "bash: [sandbox: file access denied]", count: 28 },
          { signature: "read: no such file", count: 22 },
        ],
        tools: [
          { tool: "bash", calls: 2140, errors: 122 },
          { tool: "read", calls: 1310, errors: 4 },
          { tool: "edit", calls: 860, errors: 31 },
          { tool: "subagent", calls: 420, errors: 12 },
          { tool: "web_search", calls: 380, errors: 96 },
          { tool: "glob", calls: 240, errors: 1 },
          { tool: "grep", calls: 180, errors: 3 },
          { tool: "write", calls: 150, errors: 7 },
          { tool: "job_output", calls: 60, errors: 0 },
          { tool: "ask_user_question", calls: 30, errors: 0 },
        ],
        series: [
          { d: "2026-08-23", calls: 320, errors: 21 },
          { d: "2026-08-24", calls: 1180, errors: 47 },
          { d: "2026-08-25", calls: 2050, errors: 98 },
          { d: "2026-08-26", calls: 1500, errors: 62 },
          { d: "2026-08-27", calls: 770, errors: 84 },
        ],
      },
      {
        id: "local-b / Demo-27B-FP8",
        sessions: 138,
        toolCalls: 1960,
        toolErrors: 147,
        errorRate: 0.075,
        topTools: [
          { tool: "bash", calls: 980, errors: 64 },
          { tool: "read", calls: 640, errors: 2 },
          { tool: "edit", calls: 290, errors: 48 },
          { tool: "computer_click", calls: 50, errors: 33 },
        ],
        topErrors: [
          { signature: "computer_click: 元素编号过期(AX 树失效)", count: 33 },
          { signature: "bash: [exit code: 1]", count: 44 },
          { signature: "edit: old_string 不唯一", count: 15 },
        ],
        tools: [
          { tool: "bash", calls: 980, errors: 64 },
          { tool: "read", calls: 640, errors: 2 },
          { tool: "edit", calls: 290, errors: 48 },
          { tool: "computer_click", calls: 50, errors: 33 },
          { tool: "browser_open", calls: 40, errors: 0 },
          { tool: "screen_observe", calls: 35, errors: 0 },
          { tool: "computer_type", calls: 25, errors: 0 },
        ],
        series: [
          { d: "2026-08-25", calls: 120, errors: 8 },
          { d: "2026-08-26", calls: 900, errors: 71 },
          { d: "2026-08-27", calls: 940, errors: 68 },
        ],
      },
    ],
  };
}

/**
 * 同源校验:dsh-web-review 同款 Origin 检查 + 同源 GET 兜底。
 * 注意:浏览器对同源 GET 不发 Origin 头(只发 Referer),跨域才发 Origin。
 * 因此:有 Origin → 必须与 host 相等;无 Origin → 用 Referer 与 host 相等兜底。
 * 两者都没有(curl 裸请求)→ 拒绝。
 */
function originMatches(req, headerValue) {
  const host = req.headers.host;
  if (typeof host !== "string" || typeof headerValue !== "string") return false;
  let requestHost;
  try {
    requestHost = new URL("http://" + host).host;
  } catch {
    return false;
  }
  try {
    const u = new URL(headerValue);
    return u.host === requestHost && (u.protocol === "http:" || u.protocol === "https:");
  } catch {
    return false;
  }
}

function requestOriginOk(req) {
  const origin = req.headers.origin;
  if (typeof origin === "string") return originMatches(req, origin);
  return originMatches(req, req.headers.referer);
}

function json(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

/** 解析 ?days=(合法:7/30/90 数值或 today/yesterday 字符串;其余按 0=全量)。req.url 缺失/非法 → 0。 */
function parseDaysParam(req) {
  try {
    const u = new URL(req.url || "", "http://x");
    const raw = u.searchParams.get("days");
    if (raw === "today" || raw === "yesterday") return raw;
    const n = Number(raw);
    return n === 7 || n === 30 || n === 90 ? n : 0;
  } catch {
    return 0;
  }
}

function profileHandler(store) {
  return async (req, res) => {
    if (req.headers[CLIENT_HEADER] !== CLIENT_HEADER_VALUE) {
      return json(res, 403, { error: "forbidden: client header missing or wrong" });
    }
    if (!requestOriginOk(req)) {
      return json(res, 403, { error: "forbidden: origin mismatch" });
    }
    if (req.method !== "GET") {
      return json(res, 405, { error: "method not allowed" });
    }
    try {
      // P1: 有 live 数据返回真实聚合;尚无(首扫未完成/root 缺失)回退 mock。
      // P1.5: ?days=7/30/90/today/yesterday 窗口聚合(锚点=数据最大日);非法/缺失=全量。
      return json(res, 200, store.getPayload(parseDaysParam(req)) ?? summaryPayload());
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  };
}

export async function apply(ctx) {
  const store = new ProfileStore({ sessionsRoot: defaultSessionsRoot() });
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: PROFILE_PATH,
    handler: profileHandler(store),
  }), "dsh-cap-profile: /capability-profile route");
  // 后台扫描:首扫立即 + 60s 增量 + 24h 全量自愈(定时器 unref,不挡进程退出)。
  store.start();
}
