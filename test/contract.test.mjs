#!/usr/bin/env node
/**
 * dsh-cap-profile 面板契约测试(red/green)
 *
 * 用法:
 *   node test/contract.test.mjs                 # 默认测 lib/client.js
 *   node test/contract.test.mjs <file>          # 指定目标文件
 *
 * 覆盖(白底两 Pane v2 + P2.0 多模型对比):
 *  - 设计语言(与 dsh-model-manager 同款白底 GitHub-light): --bg #ffffff 等 token、
 *    320px 1fr 两 Pane、pill 999px、tabular-nums、.12s 过渡、focus-visible、
 *    reduced-motion、窄列单列降级
 *  - 数据通道不变量: /capability-profile + v1 头、60s 轮询、404 文案、models 校验、tab 注册
 *  - 状态 SSR(零依赖 fake React): 加载 / 数据(两 Pane + [object Object] 回归) /
 *    错误条 / 搜索过滤 / P1 形状数据直渲(3 模型、零错误、空 topErrors)
 *  - P2.0 对比: 行勾选框(≤4) / 「对比 (N)」按钮 / 对比视图四块(核心指标 / 工具矩阵 /
 *    错误签名 / 每日趋势)/ 矩阵展开收起 / 缺数据回退(单模型详情、topTools、趋势隐藏)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(process.argv[2] || path.join(here, "..", "lib", "client.js"));
const src = fs.readFileSync(target, "utf8");

/* ---------- 1. 语法 ---------- */

test("目标文件语法 node --check", () => {
  execFileSync("node", ["--check", target], { stdio: "pipe" });
});

/* ---------- 2. 设计语言契约(模型管理同款白底) ---------- */

const design = [
  ["白底 --bg:#ffffff", /--bg:#ffffff/],
  ["页面底 --page:#eef1f5", /--page:#eef1f5/],
  ["边框 --line:#d0d7de", /--line:#d0d7de/],
  ["强调色 --accent:#0969da", /--accent:#0969da/],
  ["危险色 --danger:#cf222e", /--danger:#cf222e/],
  ["两 Pane 网格 320px 1fr", /grid-template-columns:320px 1fr/],
  ["左 Pane 类", /cp-paneL/],
  ["右 Pane 类", /cp-paneR/],
  ["左列搜索框", /cp-search/],
  ["pill 徽章 999px", /border-radius:999px/],
  ["0.12s 微交互", /transition:[^;]*\.12s/],
  ["focus-visible 描边", /:focus-visible\{outline:2px solid var\(--accent\)/],
  ["reduced-motion 降级", /@media \(prefers-reduced-motion:reduce\)/],
  ["窄列单列降级", /@media \(max-width:860px\)/],
  ["tabular-nums", /tabular-nums/],
  ["根类名 cp-root", /className: "cp-root"/],
  ["详情表 cp-table", /cp-table/],
  ["不再用旧版深色 --cap- token", null],
];

for (const [name, re] of design) {
  test("设计语言: " + name, () => {
    if (re === null) {
      assert.ok(!/--cap-/.test(src), "仍残留旧版深色 --cap- token");
      return;
    }
    assert.ok(re.test(src), "缺少: " + name);
  });
}

/* ---------- 3. 数据通道与行为不变量 ---------- */

const invariants = [
  'PROFILE_PATH = "/capability-profile"',
  'CLIENT_HEADER = "x-dsh-cap-profile-client"',
  'CLIENT_HEADER_VALUE = "v1"',
  "REFRESH_MS = 60000",
  "404:宿主路由未注册(node 半可能未加载或 dsh 未重启)",
  "响应结构不符(缺 models 数组)",
  "order: 40",
  'label: "能力画像"',
  'id: "capability-profile"',
  'id: "dsh-cap-profile"',
  'const inject = ["slots"]',
  "回顾式分析",
  "正在读取会话档案",
  "示例数据",
  "模块级缓存",
  "cp-filters",
  "cachedRangeDays",
  '?days=',
  "本时间段暂无模型",
  "示例数据不支持时间筛选",
  "今天",
  "昨天",
  /* P2.0 多模型对比 */
  "加入对比",
  "模型对比",
  "核心指标",
  "工具使用矩阵",
  "每日趋势",
  "cp-cmpBox",
  "cachedCompareIds",
  "cp-cmpColProv",
  "cp-cmpTbl",
  "position:sticky",
];

for (const needle of invariants) {
  test("不变量: " + needle, () => {
    assert.ok(src.includes(needle), "缺少: " + needle);
  });
}

test("不变量: 错误条 role=alert", () => {
  assert.ok(src.includes('role: "alert"'), "错误条缺少 role:alert");
});

test("无 default export", () => {
  assert.ok(!/exports\.default/.test(src), "不允许 default export");
});

/* ---------- 4. 状态 SSR(fake React,零依赖) ---------- */

function makeFakeReactWithStates(stateValues) {
  let i = 0;
  function createElement(type, props, ...children) {
    const flat = children.flat(Infinity);
    return { type, props: { ...(props || {}), children: flat } };
  }
  return {
    createElement,
    useState: (init) => {
      const cur = i++;
      return [
        stateValues && stateValues[cur] !== undefined
          ? stateValues[cur]
          : (typeof init === "function" ? init() : init),
        () => {},
      ];
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
  };
}

function loadPlugin(file, fakeReact) {
  const code = fs.readFileSync(file, "utf8");
  const captured = {};
  const win = { __ModuleLoader__: { load: (spec) => { captured.spec = spec; } } };
  const fakeRequire = (name) => (name === "react" ? fakeReact : null);
  const fakeModule = { exports: {} };
  new Function("window", "require", "module", "exports", code)(win, fakeRequire, fakeModule, fakeModule.exports);
  assert.ok(captured.spec && typeof captured.spec.factory === "function", "插件未注册到 __ModuleLoader__");
  return captured.spec.factory(fakeRequire);
}

function collect(node, out) {
  if (node == null || typeof node === "boolean") return;
  if (Array.isArray(node)) { node.forEach((n) => collect(n, out)); return; }
  if (typeof node === "string" || typeof node === "number") { out.text.push(String(node)); return; }
  const { type, props = {} } = node;
  if (typeof type === "function") { collect(type(props), out); return; }
  if (typeof props.className === "string") out.classes.push(props.className);
  if (type === "div" && props.className === "cp-root") out.rootStyle = props.style;
  collect(props.children, out);
}

function renderPanel(stateValues) {
  const exports = loadPlugin(target, makeFakeReactWithStates(stateValues));
  assert.deepEqual(exports.inject, ["slots"]);
  let capturedSlot = null, tabConfig = null, panel = null;
  const ctx = {
    slots: {
      inject: (slotName, fn) => { capturedSlot = slotName; fn(); },
      register: (config, comp) => { tabConfig = config; panel = comp; },
    },
  };
  exports.apply(ctx);
  assert.equal(capturedSlot, "conversation.view");
  assert.equal(tabConfig.id, "capability-profile");
  assert.equal(tabConfig.order, 40);
  assert.equal(tabConfig.label, "能力画像");
  const tree = panel({});
  const out = { text: [], classes: [] };
  collect(tree, out);
  out.tree = tree; // 供 rowIds 等结构断言使用
  return out;
}

const MOCK_DOC = {
  source: "mock",
  generatedAt: "2026-08-27T03:00:00.000Z",
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
      ],
      topErrors: [
        { signature: "web_search: API key invalid (502)", count: 96 },
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
      ],
      topErrors: [],
    },
  ],
};

// useState 声明顺序(契约!): doc, error, loading, pulse, updatedAt, selectedId, query

test("SSR: 加载态渲染 + tab 注册", () => {
  const out = renderPanel(undefined);
  const text = out.text.join(" ");
  for (const needle of ["模型能力画像", "回顾式分析 · 60s 自动刷新", "正在读取会话档案", "同步中…", "刷新"]) {
    assert.ok(text.includes(needle), "加载态渲染缺少文本: " + needle);
  }
  for (const cls of ["cp-root", "cp-head", "cp-body", "cp-paneL", "cp-paneR", "cp-search", "cp-loading"]) {
    assert.ok(out.classes.includes(cls), "加载态渲染缺少类: " + cls);
  }
});

test("SSR: 数据态渲染(两 Pane + [object Object] 拼接回归防护)", () => {
  const out = renderPanel([MOCK_DOC, "", false, 1, Date.now(), null, ""]);
  const text = out.text.join(" ");
  for (const needle of [
    "模型能力画像", "示例数据", "模型 2 / 2",
    "5.4%", "7.5%", "×96",
    "常用工具 Top", "高频错误签名 Top",
    "2,140", "122", "412", "5,820",
    "Demo-VL-35B-A3B",
  ]) {
    assert.ok(text.includes(needle), "数据态渲染缺少文本: " + needle);
  }
  assert.ok(!text.includes("[object Object]"), "字符串 + React 元素拼接 bug(会渲染出 [object Object])");
  const anyClass = (frag) => out.classes.some((c) => c.includes(frag));
  for (const cls of ["cp-row--sel", "cp-pill--fail", "cp-pill--warn", "cp-table", "cp-tRow", "cp-eHead", "cp-note"]) {
    assert.ok(anyClass(cls), "数据态渲染缺少类: " + cls);
  }
});

test("SSR: 搜索过滤(仅匹配行保留,选中回落到首个匹配)", () => {
  const out = renderPanel([MOCK_DOC, "", false, 1, Date.now(), null, "27b"]);
  const text = out.text.join(" ");
  assert.ok(text.includes("模型 1 / 2"), "搜索计数错误");
  assert.ok(text.includes("Demo-27B-FP8"), "搜索结果应含 Demo-27B-FP8 模型");
  assert.ok(!text.includes("Demo-VL-35B-A3B"), "搜索后不应再出现 Demo-VL 行/详情");
});

test("SSR: 搜索无结果", () => {
  const out = renderPanel([MOCK_DOC, "", false, 1, Date.now(), null, "zzz-no-match"]);
  const text = out.text.join(" ");
  assert.ok(text.includes("无匹配的模型"), "搜索无结果提示缺失");
});

test("SSR: 错误态渲染(错误条 + role=alert 类)", () => {
  const out = renderPanel([null, "数据加载失败: 404:宿主路由未注册(node 半可能未加载或 dsh 未重启)", false, 1, null, null, ""]);
  const text = out.text.join(" ");
  assert.ok(text.includes("404:宿主路由未注册(node 半可能未加载或 dsh 未重启)"), "错误态渲染缺少错误信息");
  assert.ok(out.classes.some((c) => c.includes("cp-flash")), "错误态渲染缺少类 cp-flash");
});

test("SSR: P1 形状数据直渲(3 模型 / 零错误 / 空 topErrors / 长签名)", () => {
  const p1Doc = {
    source: "live",
    generatedAt: "2026-08-28T15:00:00.000Z",
    note: "数据源 ~/.dsh/sessions",
    models: [
      MOCK_DOC.models[0],
      {
        id: "local-b / Demo-27B-FP8",
        sessions: 138, toolCalls: 1960, toolErrors: 147, errorRate: 0.032,
        topTools: [{ tool: "bash", calls: 980, errors: 64 }],
        topErrors: [
          { signature: "bash: [sandbox: file access denied under workspace-write mode] 长路径 /models/templates/Demo-Chat-Templates/demo-template-v22.3 不应崩溃", count: 22 },
        ],
      },
      {
        id: "deepseek-v4-flash / deepseek-v4-flash",
        sessions: 6, toolCalls: 210, toolErrors: 0, errorRate: 0,
        topTools: [{ tool: "bash", calls: 90, errors: 0 }],
        topErrors: [],
      },
    ],
  };
  // selectedId 指向 local-b / Demo-27B-FP8,验证长签名渲染;零错误模型的 (无)/ok pill 在左列表
  const out = renderPanel([p1Doc, "", false, 1, Date.now(), "local-b / Demo-27B-FP8", ""]);
  const text = out.text.join(" ");
  assert.ok(text.includes("模型 3 / 3"), "3 模型计数错误");
  assert.ok(!text.includes("示例数据"), "source=live 不应显示示例数据徽章");
  assert.ok(text.includes("×22"), "长签名计数缺失");
  assert.ok(text.includes("demo-template-v22.3"), "长签名全文应渲染");
  assert.ok(text.includes("×96") === false, "未选中的 local-a 详情不应渲染");
  assert.ok(!text.includes("[object Object]"), "[object Object] 回归");
  const anyClass = (frag) => out.classes.some((c) => c.includes(frag));
  assert.ok(anyClass("cp-pill--ok"), "零错误模型左行应有 ok pill");
  assert.ok(anyClass("cp-pill--warn"), "3.2% 错误率应有 warn pill");

  // 选中零错误模型:空 topErrors 渲染 (无)
  const out2 = renderPanel([p1Doc, "", false, 1, Date.now(), "deepseek-v4-flash / deepseek-v4-flash", ""]);
  assert.ok(out2.text.join(" ").includes("(无)"), "零错误模型空 topErrors 应显示 (无)");
});

test("SSR: 模块级缓存(切 tab 重挂载首屏直渲旧数据,不闪 loading,后台仍 revalidate)", async () => {
  const realFetch = globalThis.fetch;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls++;
    return { ok: true, status: 200, json: async () => MOCK_DOC };
  };
  globalThis.setInterval = () => 0; // 不挂 60s 真定时器(会让测试进程延迟退出)
  globalThis.clearInterval = () => {};
  try {
    let effectFn = null;
    const fr = makeFakeReactWithStates(undefined); // 无注入 → useState 全部回落初始值
    fr.useEffect = (fn) => { effectFn = fn; }; // 捕获 mount effect(load + setInterval)
    const exp = loadPlugin(target, fr);
    let panel = null;
    const ctx = { slots: { inject: (n, f) => f(), register: (c, p) => { panel = p; } } };
    exp.apply(ctx);
    assert.ok(panel, "面板组件未注册");

    // 首挂载:缓存空 → loading 态;effect 触发一次 fetch → 写模块级缓存
    const out1 = { text: [], classes: [] };
    collect(panel({}), out1);
    assert.ok(out1.text.join(" ").includes("正在读取会话档案"), "首挂载(无缓存)应为 loading 态");
    assert.equal(typeof effectFn, "function", "mount effect 未被捕获");
    effectFn();
    await new Promise((r) => setImmediate(r)); // 等 load() 的 fetch/json 微任务落定
    assert.equal(fetchCalls, 1, "首挂载应恰好 fetch 一次");

    // 二次挂载(模拟切回 tab):useState 索引 7..13 无注入 → 回落初始值,
    // 初始值必须读模块级缓存 → 首屏直渲旧数据,不闪「正在读取会话档案…」
    const out2 = { text: [], classes: [] };
    collect(panel({}), out2);
    const text2 = out2.text.join(" ");
    assert.ok(text2.includes("模型 2 / 2"), "重挂载应直渲缓存数据(模型计数)");
    assert.ok(!text2.includes("正在读取会话档案"), "重挂载不应闪 loading 文本");
    assert.ok(text2.includes("Demo-VL-35B-A3B"), "缓存数据应含模型名");

    // 重挂载的 mount effect 仍要后台 revalidate
    effectFn();
    await new Promise((r) => setImmediate(r));
    assert.equal(fetchCalls, 2, "重挂载应触发后台 revalidate fetch");
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  }
});

/* ---------- 排序控件(左栏 kicker 行) ---------- */

// useState 注入契约: 0 doc, 1 error, 2 loading, 3 pulse, 4 updatedAt,
// 5 selectedId, 6 query, 7 sortKey(新增,追加在 query 之后)
const SORT_DOC = {
  source: "live",
  generatedAt: "2026-08-28T16:00:00.000Z",
  note: "sort fixture",
  models: [
    { id: "pa / zeta-model", sessions: 100, toolCalls: 500, toolErrors: 5, errorRate: 0.01, topTools: [], topErrors: [] },
    { id: "pb / alpha-model", sessions: 30, toolCalls: 900, toolErrors: 81, errorRate: 0.09, topTools: [], topErrors: [] },
    { id: "pc / mid-model", sessions: 500, toolCalls: 200, toolErrors: 10, errorRate: 0.05, topTools: [], topErrors: [] },
  ],
};

// DFS 收集渲染树中所有 cp-row 的 title(=模型 id),保持 DOM 顺序
function rowIds(node, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => rowIds(n, out)); return out; }
  const { type, props = {} } = node;
  if (typeof type === "function") { rowIds(type(props), out); return out; }
  const cls = typeof props.className === "string" ? props.className : "";
  if (type === "button" && cls.includes("cp-row") && typeof props.title === "string") out.push(props.title);
  rowIds(props.children, out);
  return out;
}

function sortState(sortKey) {
  const s = [SORT_DOC, "", false, 1, Date.now(), null, ""];
  if (sortKey !== undefined) s[7] = sortKey;
  return s;
}

test("SSR: 排序控件(4 选项) + 默认=工具调用降序(=服务端序)", () => {
  const out = renderPanel(sortState(undefined));
  const text = out.text.join(" ");
  assert.ok(out.classes.some((c) => c.includes("cp-sort")), "缺少排序控件 cp-sort");
  assert.ok(text.includes("模型 3 / 3"), "模型计数缺失");
  for (const opt of ["工具调用", "会话数", "错误率", "模型名"]) {
    assert.ok(text.includes(opt), "排序选项缺失: " + opt);
  }
  assert.deepEqual(rowIds(out.tree),
    ["pb / alpha-model", "pa / zeta-model", "pc / mid-model"],
    "默认排序应为工具调用降序 900>500>200");
});

test("SSR: 排序各选项(错误率降序 / 会话数降序 / 模型名升序)", () => {
  assert.deepEqual(rowIds(renderPanel(sortState("errors")).tree),
    ["pb / alpha-model", "pc / mid-model", "pa / zeta-model"], "错误率降序 0.09>0.05>0.01");
  assert.deepEqual(rowIds(renderPanel(sortState("sessions")).tree),
    ["pc / mid-model", "pa / zeta-model", "pb / alpha-model"], "会话数降序 500>100>30");
  assert.deepEqual(rowIds(renderPanel(sortState("name")).tree),
    ["pa / zeta-model", "pb / alpha-model", "pc / mid-model"], "模型名升序 pa<pb<pc");
});

/* ---------- 时间范围筛选(P1.5) ----------
   useState 注入契约追加: 8 rangeDays("0"=全部 / "today" / "yesterday" / "7"/"30"/"90",select 原始字符串) */

function findSelects(node, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => findSelects(n, out)); return out; }
  const { type, props = {} } = node;
  if (typeof type === "function") { findSelects(type(props), out); return out; }
  if (type === "select") out.push(props);
  findSelects(props.children, out);
  return out;
}

const WIN_DOC = {
  source: "live",
  generatedAt: "2026-08-28T16:00:00.000Z",
  note: "window fixture",
  window: { from: "2026-08-22", to: "2026-08-28", days: 7 },
  models: SORT_DOC.models,
};

test("SSR: 筛选行(时间 6 选项 全部/今天/昨天/7/30/90 + 排序 4 选项 并存)", () => {
  const out = renderPanel([WIN_DOC, "", false, 1, Date.now(), null, "", "calls", "7"]);
  const text = out.text.join(" ");
  assert.ok(out.classes.some((c) => c.includes("cp-filters")), "缺少筛选行 cp-filters");
  for (const opt of ["全部", "今天", "昨天", "近 7 天", "近 30 天", "近 90 天"]) {
    assert.ok(text.includes(opt), "时间选项缺失: " + opt);
  }
  for (const opt of ["工具调用", "会话数", "错误率", "模型名"]) {
    assert.ok(text.includes(opt), "排序选项缺失: " + opt);
  }
  const selects = findSelects(out.tree);
  assert.ok(selects.length >= 2, "筛选行应有时间 + 排序两个 select");
  const range = selects.find((s) => s.value === "7");
  assert.ok(range, "时间 select 应绑定 rangeDays 值 \"7\"(字符串)");
});

test("SSR: mock 数据 → 时间 select 禁用(title 提示),排序 select 不禁用", () => {
  const out = renderPanel([MOCK_DOC, "", false, 1, Date.now(), null, "", "calls", "7"]);
  const selects = findSelects(out.tree);
  const range = selects.find((s) => s.value === "7");
  assert.ok(range, "时间 select 缺失");
  assert.equal(range.disabled, true, "mock 数据时间 select 应禁用");
  assert.equal(range.title, "示例数据不支持时间筛选");
  const sortSel = selects.find((s) => s.value === "calls");
  assert.ok(sortSel, "排序 select 缺失");
  assert.ok(!sortSel.disabled, "排序 select 不应禁用");
});

test("SSR: live + window → meta 行显示窗口区间", () => {
  const out = renderPanel([WIN_DOC, "", false, 1, Date.now(), null, "", "calls", "7"]);
  const text = out.text.join(" ");
  assert.ok(text.includes("窗口 2026-08-22 ~ 2026-08-28"), "meta 应显示窗口区间");
});

test("SSR: live + 单日窗口(today) → meta 只显示日期(不用 ~)", () => {
  const TODAY_DOC = {
    source: "live",
    generatedAt: "2026-08-28T16:00:00.000Z",
    note: "today fixture",
    window: { from: "2026-08-28", to: "2026-08-28", days: "today" },
    models: SORT_DOC.models,
  };
  const out = renderPanel([TODAY_DOC, "", false, 1, Date.now(), null, "", "calls", "today"]);
  const text = out.text.join(" ");
  assert.ok(text.includes("窗口 2026-08-28"), "meta 应显示单日窗口日期");
  assert.ok(!text.includes("2026-08-28 ~ 2026-08-28"), "单日窗口不应带 ~ 区间");
});

test("SSR: live + window + 空模型 → 「本时间段暂无模型」(左右空态)", () => {
  const emptyWinDoc = { source: "live", generatedAt: "2026-08-28T16:00:00.000Z", note: "empty window", window: { from: "2026-08-22", to: "2026-08-28", days: 7 }, models: [] };
  const out = renderPanel([emptyWinDoc, "", false, 1, Date.now(), null, "", "calls", "7"]);
  const text = out.text.join(" ");
  assert.ok(text.includes("本时间段暂无模型"), "窗口空态提示缺失");
  assert.ok(!text.includes("暂无会话档案"), "窗口空态不应回落到全量空态文案");
});

/* ---------- 常用工具表 per-tool 错误率列(P1.6) ---------- */

const TOOL_DOC = {
  source: "live",
  generatedAt: "2026-08-28T16:00:00.000Z",
  note: "tool rate fixture",
  models: [
    {
      id: "pt / tool-model", sessions: 10, toolCalls: 190, toolErrors: 11, errorRate: 0.0579,
      topTools: [
        { tool: "bash", calls: 100, errors: 10 },
        { tool: "read", calls: 50, errors: 0 },
        { tool: "edit", calls: 40, errors: 1 },
      ],
      topErrors: [],
    },
  ],
};

test("SSR: 常用工具表 per-tool 错误率列(0 错误灰 / <5% 琥珀 / ≥5% 红)", () => {
  const out = renderPanel([TOOL_DOC, "", false, 1, Date.now(), null, "", "calls", "0"]);
  const text = out.text.join(" ");
  assert.ok(text.includes("10.0%"), "bash 10/100 → 10.0%");
  assert.ok(text.includes("2.5%"), "edit 1/40 → 2.5%");
  assert.ok(text.includes("0.0%"), "read 0/50 → 0.0%");
  const cls = out.classes.filter((c) => typeof c === "string" && c.includes("cp-num--"));
  assert.ok(cls.some((c) => c.includes("cp-num--fail")), "≥5% 应为红色 tone");
  assert.ok(cls.some((c) => c.includes("cp-num--warn")), "<5% 应为琥珀 tone");
  assert.ok(cls.some((c) => c.includes("cp-num--zero")), "0 错误应为灰");
});

/* ---------- 多模型对比(P2.0) ----------
   useState 注入契约追加: 9 compareIds(string[]), 10 viewMode("detail"|"compare"), 11 matrixExpanded(bool)
   新状态一律放主组件(CapProfilePanel),ComparePane 只收 props —— 不破坏 fake React 按索引注入的契约。 */

const CMP_DOC = {
  source: "live",
  generatedAt: "2026-08-28T17:00:00.000Z",
  note: "compare fixture",
  models: [
    {
      id: "pa / alpha", sessions: 100, toolCalls: 900, toolErrors: 81, errorRate: 0.09,
      topTools: [{ tool: "bash", calls: 500, errors: 60 }],
      topErrors: [{ signature: "bash: [exit code: 1]", count: 60 }],
      tools: [
        { tool: "bash", calls: 500, errors: 60 },
        { tool: "read", calls: 300, errors: 5 },
        { tool: "edit", calls: 100, errors: 16 },
      ],
      series: [
        { d: "2026-08-26", calls: 100, errors: 9 },
        { d: "2026-08-27", calls: 400, errors: 36 },
        { d: "2026-08-28", calls: 400, errors: 36 },
      ],
    },
    {
      id: "pb / beta", sessions: 60, toolCalls: 500, toolErrors: 5, errorRate: 0.01,
      topTools: [{ tool: "read", calls: 200, errors: 1 }],
      topErrors: [{ signature: "read: no such file", count: 1 }],
      tools: [
        { tool: "read", calls: 200, errors: 1 },
        { tool: "grep", calls: 150, errors: 2 },
        { tool: "bash", calls: 150, errors: 2 },
      ],
      series: [
        { d: "2026-08-27", calls: 200, errors: 2 },
        { d: "2026-08-28", calls: 300, errors: 3 },
      ],
    },
  ],
};

// 5 模型 × 各 10 个互不相同工具 → 矩阵并集 40 行(>15,触发展开/收起)
const CMP_DOC5 = {
  source: "live",
  generatedAt: "2026-08-28T17:00:00.000Z",
  note: "compare cap fixture",
  models: [0, 1, 2, 3, 4].map((i) => ({
    id: "p5 / m" + (i + 1),
    sessions: 10 + i, toolCalls: 500 + i * 10, toolErrors: i, errorRate: 0.01 * (i + 1) / 10,
    topTools: [], topErrors: [],
    tools: Array.from({ length: 10 }, (_, j) => ({ tool: "tool_" + j + "_" + i, calls: 100 - j, errors: 0 })),
    series: [],
  })),
};

const cmpState = (doc, compareIds, viewMode, expanded) =>
  [doc, "", false, 1, Date.now(), null, "", "calls", "0", compareIds, viewMode, expanded];

function findInputs(node, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => findInputs(n, out)); return out; }
  const { type, props = {} } = node;
  if (typeof type === "function") { findInputs(type(props), out); return out; }
  if (type === "input") out.push(props);
  findInputs(props.children, out);
  return out;
}

function cmpToolRows(node, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => cmpToolRows(n, out)); return out; }
  const { type, props = {} } = node;
  if (typeof type === "function") { cmpToolRows(type(props), out); return out; }
  const cls = typeof props.className === "string" ? props.className : "";
  if (type === "span" && cls.includes("cp-mTool")) out.push(String((props.children || []).map((c) => (typeof c === "string" ? c : "")).join("")));
  cmpToolRows(props.children, out);
  return out;
}

test("SSR: 模型行对比勾选框(aria-label / checked 反映选中 / 已选 4 个时未选项禁用)", () => {
  const out = renderPanel(cmpState(CMP_DOC, ["pa / alpha"], "detail", false));
  const boxes = findInputs(out.tree).filter((p) => p.type === "checkbox");
  assert.equal(boxes.length, 2, "每行一个对比勾选框");
  const byLabel = {};
  for (const b of boxes) byLabel[b["aria-label"]] = b;
  assert.ok(byLabel["加入对比 pa / alpha"], "aria-label 应含模型 id");
  assert.equal(byLabel["加入对比 pa / alpha"].checked, true, "已选模型 checkbox 应 checked");
  assert.equal(byLabel["加入对比 pb / beta"].checked, false, "未选模型 checkbox 应未 checked");

  const out4 = renderPanel(cmpState(CMP_DOC5, ["p5 / m1", "p5 / m2", "p5 / m3", "p5 / m4"], "detail", false));
  const boxes4 = findInputs(out4.tree).filter((p) => p.type === "checkbox");
  assert.equal(boxes4.length, 5, "5 模型 5 个勾选框");
  const m5 = boxes4.find((b) => String(b["aria-label"] || "").includes("p5 / m5"));
  assert.equal(m5 && m5.disabled, true, "已选满 4 个后未选行的勾选框应禁用");
  const m1 = boxes4.find((b) => String(b["aria-label"] || "").includes("p5 / m1"));
  assert.equal(m1 && m1.disabled, false, "已选行的勾选框(用于取消)不禁用");
});

test("SSR: 「对比」按钮(有效选中 ≥2 才出现,1 或 0 个不出现)", () => {
  const t0 = renderPanel(cmpState(CMP_DOC, [], "detail", false)).text.join(" ");
  assert.ok(!t0.includes("对比 ("), "0 选中不应出现对比按钮");
  const t1 = renderPanel(cmpState(CMP_DOC, ["pa / alpha"], "detail", false)).text.join(" ");
  assert.ok(!t1.includes("对比 ("), "1 选中不应出现对比按钮");
  const t2 = renderPanel(cmpState(CMP_DOC, ["pa / alpha", "pb / beta"], "detail", false)).text.join(" ");
  assert.ok(t2.includes("对比 (2)"), "2 选中应出现「对比 (2)」按钮");
});

test("SSR: 对比视图 — 核心指标(错误率最低绿最高红 / 调用数最高加粗)", () => {
  const out = renderPanel(cmpState(CMP_DOC, ["pa / alpha", "pb / beta"], "compare", false));
  const text = out.text.join(" ");
  for (const needle of ["模型对比", "核心指标", "工具使用矩阵", "高频错误签名", "每日趋势", "← 单模型画像"]) {
    assert.ok(text.includes(needle), "对比视图缺少: " + needle);
  }
  assert.ok(text.includes("9.0%"), "alpha 错误率 0.09 → 9.0%");
  assert.ok(text.includes("1.0%"), "beta 错误率 0.01 → 1.0%");
  assert.ok(text.includes("900") && text.includes("500"), "工具调用 900 / 500");
  const anyClass = (frag) => out.classes.some((c) => typeof c === "string" && c.includes(frag));
  assert.ok(anyClass("cp-num--best"), "最低错误率/错误数应有绿色 best 类");
  assert.ok(anyClass("cp-num--worst"), "最高错误率/错误数应有红色 worst 类");
  assert.ok(anyClass("cp-num--top"), "最高调用量应有加粗 top 类");
  // 对比视图替换单模型详情
  assert.ok(!text.includes("常用工具 Top"), "对比视图不应渲染单模型详情");
});

test("SSR: 对比视图 — 工具矩阵(并集行 / 按最大调用降序 / 缺失列 — / 展开收起)", () => {
  const out = renderPanel(cmpState(CMP_DOC, ["pa / alpha", "pb / beta"], "compare", false));
  assert.deepEqual(cmpToolRows(out.tree), ["bash", "read", "grep", "edit"], "矩阵行序 = 行内最大调用降序");
  const text = out.text.join(" ");
  assert.ok(text.includes("—"), "该模型无此工具应显示 —");
  assert.ok(text.includes("12.0%"), "bash@alpha 60/500 → 12.0%");
  assert.ok(text.includes("×60"), "错误签名矩阵 alpha bash 签名 ×60");
  assert.ok(!text.includes("展开全部"), "并集 ≤15 行不需要展开按钮");

  // 40 行并集:折叠 15 行 + 「展开全部 40 个工具」;展开 40 行 + 「收起」
  const ids4 = ["p5 / m1", "p5 / m2", "p5 / m3", "p5 / m4"];
  const collapsed = renderPanel(cmpState(CMP_DOC5, ids4, "compare", false));
  assert.equal(cmpToolRows(collapsed.tree).length, 15, "默认只展开 15 行");
  assert.ok(collapsed.text.join(" ").includes("展开全部 40 个工具"), "展开按钮带总数");
  const expanded = renderPanel(cmpState(CMP_DOC5, ids4, "compare", true));
  assert.equal(cmpToolRows(expanded.tree).length, 40, "展开后全部 40 行");
  assert.ok(expanded.text.join(" ").includes("收起"), "展开后按钮变「收起」");
});

test("SSR: 对比视图 — 每日趋势(日期行 / 条形 / 当日错误 ×N / 无 series 时整块不渲染)", () => {
  const out = renderPanel(cmpState(CMP_DOC, ["pa / alpha", "pb / beta"], "compare", false));
  const text = out.text.join(" ");
  for (const d of ["08-26", "08-27", "08-28"]) assert.ok(text.includes(d), "趋势应含日期 " + d);
  assert.ok(text.includes("×9"), "当日错误 α 08-26 → ×9");
  assert.ok(out.classes.some((c) => typeof c === "string" && c.includes("cp-tBar")), "趋势条形类 cp-tBar 缺失");

  // 无 series 字段(mock 旧形状)→ 趋势块整体不渲染,矩阵回落 topTools
  const out2 = renderPanel(cmpState(MOCK_DOC,
    ["local-a / Demo-VL-35B-A3B", "local-b / Demo-27B-FP8"], "compare", false));
  const text2 = out2.text.join(" ");
  assert.ok(text2.includes("模型对比"), "mock 形状仍应进入对比视图");
  assert.ok(!text2.includes("每日趋势"), "无 series 数据不应渲染趋势块");
  assert.ok(text2.includes("工具使用矩阵"), "矩阵应回落 topTools");
});

function findCmpCols(node, out = []) {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) { node.forEach((n) => findCmpCols(n, out)); return out; }
  const { type, props = {} } = node;
  if (typeof type === "function") { findCmpCols(type(props), out); return out; }
  const cls = typeof props.className === "string" ? props.className : "";
  if (type === "span" && cls.split(/\s+/).includes("cp-cmpCol")) out.push(props);
  findCmpCols(props.children, out);
  return out;
}

test("SSR: 对比视图 — 列模型识别(provider+名两行列头 / 列色码 / 趋势条同色 / 点列头跳单模型)", () => {
  const out = renderPanel(cmpState(CMP_DOC, ["pa / alpha", "pb / beta"], "compare", false));
  const text = out.text.join(" ");
  assert.ok(text.includes("pa"), "列头应含 provider pa");
  assert.ok(text.includes("pb"), "列头应含 provider pb");
  const cols = findCmpCols(out.tree);
  assert.equal(cols.length, 8, "4 张表 × 2 模型列 = 8 列头");
  assert.equal(typeof cols[0].onClick, "function", "列头应可点击(跳单模型)");
  assert.ok(cols[0].style && cols[0].style.borderTopColor, "列头应有列色边框");
  assert.equal(cols[0].style.borderTopColor, cols[2].style.borderTopColor, "同一模型跨表列色一致");
  assert.notEqual(cols[0].style.borderTopColor, cols[1].style.borderTopColor, "相邻模型列色不同");
  // 列头两行:第一行 provider,第二行模型短名
  const lineTexts = (p) => (p.children || []).filter((c) => typeof c === "object").map((c) => (c.props.children || []).join(""));
  assert.deepEqual(lineTexts(cols[0]), ["pa", "alpha"], "列头行序 = provider 行 + 模型名行");
  assert.deepEqual(lineTexts(cols[1]), ["pb", "beta"], "第二列 = pb / beta");
  // 趋势条颜色 = 该列的列色
  const fills = [];
  (function walk(n) {
    if (n == null || typeof n !== "object") return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    const { type, props = {} } = n;
    if (typeof type === "function") { walk(type(props)); return; }
    if (type === "div" && typeof props.className === "string" && props.className.includes("cp-tBarFill")) fills.push(props.style);
    walk(props.children);
  })(out.tree);
  assert.ok(fills.length >= 3, "趋势条形应渲染");
  assert.equal(fills[0].background, cols[0].style.borderTopColor, "条形颜色 = 模型列色");
  assert.ok(fills.some((f) => f.background === cols[1].style.borderTopColor), "第二模型条形 = 其列色");
});

test("SSR: 对比回退(有效选中 <2 → 渲染单模型详情,不崩)", () => {
  const out = renderPanel(cmpState(CMP_DOC, ["pa / alpha", "gone / x"], "compare", false));
  const text = out.text.join(" ");
  assert.ok(!text.includes("模型对比 ·"), "只有 1 个有效模型不应渲染对比视图");
  assert.ok(text.includes("常用工具 Top"), "应回落到单模型详情视图");
  assert.ok(!text.includes("对比 ("), "有效选中 1 个 → 对比按钮隐藏");
});
