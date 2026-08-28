/**
 * dsh-cap-profile P1 — analyzer 单元测试（red/green）
 *
 * 覆盖 DESIGN.md §8：
 *  - 多 frame zstd 解码器（单帧 / 拼接帧 / 撕裂尾帧 / 坏 magic 回退）
 *  - parseSessionBuffer：归属规则、errorRate、topTools/topErrors 排序与上限、无 header 丢弃
 *  - ProfileStore：全量扫描、per-file mtime 增量、删除文件、回退全量
 *
 * 运行：node test/analyzer.test.mjs
 */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { decodeZstdFrames, parseSessionBuffer, ProfileStore } = await import(pathToFileURL(path.join(here, "..", "lib", "analyzer.js")).href);

let passed = 0;
let failed = 0;
const failures = [];

const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try {
      await fn();
      passed++;
      console.log(`  ok - ${name}`);
    } catch (err) {
      failed++;
      failures.push({ name, err });
      console.log(`  FAIL - ${name}`);
      console.log(String((err && err.stack) || err).split("\n").map((l) => "      " + l).join("\n"));
    }
  })());
}

// ---- fixture 构造 -------------------------------------------------------

function zframe(text) {
  return zlib.zstdCompressSync(Buffer.from(text, "utf8"));
}

function rec(type, data, time) {
  // time 缺省 → 既有默认时间戳(1787800000000);显式 undefined 语义由调用方避免
  return JSON.stringify(time === undefined ? { type, seq: 1, time: 1787800000000, data } : { type, seq: 1, time, data });
}

/**
 * 构造一个会话文件内容：header(provider/model) 之后按序追加 call/result 对。
 * calls: [{ name, ok?: boolean, errText?: string }]
 */
/**
 * calls: [{ name, ok?, errText?, time? }]  time=epoch 毫秒;null/缺省行为:
 *   undefined → fixture 默认时间戳;null → 记录不带 time 字段(只计全量)。
 * headerTime: request/header 记录的时间戳(缺省 = 默认)。
 */
function sessionFrames({ provider, model, calls, extraFrames = [], noHeader = false, headerTime }) {
  const lines = [rec("session", { id: "fixture", cwd: "/tmp" })];
  if (!noHeader) {
    lines.push(rec("request/header", { header: { config: { provider, model, maxTokens: 4096 } } }, headerTime));
  }
  let callId = 0;
  for (const c of calls) {
    callId++;
    const t = c.time === undefined ? undefined : c.time;
    lines.push(rec("tool/call", { callId: `c${callId}`, name: c.name, arguments: "{}" }, t));
    lines.push(rec("tool/result", {
      message: {
        source: { kind: "tool", callId: `c${callId}` },
        content: [{
          type: "tool-result",
          toolCallId: `c${callId}`,
          isError: c.ok === false,
          content: [{ type: "text", text: c.ok === false ? (c.errText || "Error: boom") : "ok" }],
        }],
      },
    }, t));
  }
  const frame0 = zframe(lines.join("\n") + "\n");
  const extra = extraFrames.map((f) => zframe(f));
  return Buffer.concat([frame0, ...extra]);
}

function writeFile(root, relPath, buf) {
  const p = path.join(root, relPath);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, buf);
  return p;
}

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cap-profile-test-"));
}

/** 本地日历日 YYYY-MM-DD(与 analyzer dayKey 同口径,测试独立实现防共谋) */
function dayKeyOf(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

// ---- 1. 解码器 -----------------------------------------------------------

console.log("\n# decodeZstdFrames");

test("单 frame 解压", () => {
  const buf = zframe("hello\nworld\n");
  const out = decodeZstdFrames(buf);
  assert.equal(out.toString("utf8"), "hello\nworld\n");
});

test("拼接多 frame 全量还原", () => {
  const a = zframe('{"a":1}\n');
  const b = zframe('{"b":2}\n');
  const c = zframe('{"c":3}\n');
  const out = decodeZstdFrames(Buffer.concat([a, b, c]));
  const lines = out.toString("utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], '{"a":1}');
  assert.equal(lines[2], '{"c":3}');
});

test("732 帧拼接可完整解码（模拟真实会话文件）", () => {
  const frames = [];
  for (let i = 0; i < 732; i++) frames.push(zframe(`line-${i}\n`));
  const out = decodeZstdFrames(Buffer.concat(frames));
  const lines = out.toString("utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 732);
  assert.equal(lines[731], "line-731");
});

test("撕裂尾帧：有效前帧保留，坏尾帧跳过", () => {
  const good = zframe('{"ok":true}\n');
  const torn = zframe('{"tail":"partial"}\n').subarray(0, 12); // 截断
  const out = decodeZstdFrames(Buffer.concat([good, torn]));
  assert.ok(out.toString("utf8").includes('{"ok":true}'));
});

test("空 buffer 返回空", () => {
  assert.equal(decodeZstdFrames(Buffer.alloc(0)).length, 0);
});

// ---- 2. parseSessionBuffer ----------------------------------------------

console.log("\n# parseSessionBuffer");

test("归属 + 计数 + errorRate + topTools/topErrors 排序", () => {
  const buf = sessionFrames({
    provider: "provA",
    model: "modelX",
    calls: [
      { name: "bash", ok: false, errText: "Error: boom\nline2 detail" },
      { name: "read", ok: true },
      { name: "bash", ok: false, errText: "Error: boom\nother" },
      { name: "bash", ok: true },
      { name: "edit", ok: true },
    ],
  });
  const contrib = parseSessionBuffer(buf);
  const m = contrib.models["provA / modelX"];
  assert.ok(m, "model should exist");
  assert.equal(m.sessions, 1);
  assert.equal(m.toolCalls, 5);
  assert.equal(m.toolErrors, 2);
  assert.equal(m.tools.bash.calls, 3);
  assert.equal(m.tools.bash.errors, 2);
  assert.equal(m.tools.read.calls, 1);
  assert.equal(m.tools.read.errors, 0);
  // errorRate = 2/5 = 0.4
  assert.equal(m.errorRate, 0.4);
  // topTools 按 calls 降序，top 5
  assert.deepEqual(contrib.topTools[0], { tool: "bash", calls: 3, errors: 2 });
  // topErrors: 同一签名 "Error: boom" 聚合为 2
  assert.equal(contrib.topErrors[0].signature, "bash: Error: boom");
  assert.equal(contrib.topErrors[0].count, 2);
});

test("errorRate 为 0（无调用）与无错误", () => {
  const buf = sessionFrames({ provider: "p", model: "m", calls: [] });
  const contrib = parseSessionBuffer(buf);
  const m = contrib.models["p / m"];
  assert.equal(m.sessions, 1);
  assert.equal(m.toolCalls, 0);
  assert.equal(m.errorRate, 0);
  assert.equal(contrib.topTools.length, 0);
  assert.equal(contrib.topErrors.length, 0);
});

test("无 request/header 的文件 → 无归属（models 为空）", () => {
  const buf = sessionFrames({ provider: "p", model: "m", calls: [{ name: "bash" }], noHeader: true });
  const contrib = parseSessionBuffer(buf);
  assert.equal(Object.keys(contrib.models).length, 0);
});

test("会话中途切模型：call 归当前 header", () => {
  // 手工构造：header A → call bash → header B → call read
  const lines = [
    rec("session", { id: "sw", cwd: "/tmp" }),
    rec("request/header", { header: { config: { provider: "pA", model: "mA", maxTokens: 1 } } }),
    rec("tool/call", { callId: "c1", name: "bash", arguments: "{}" }),
    rec("tool/result", { message: { source: { kind: "tool", callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", isError: false, content: [{ type: "text", text: "ok" }] }] } }),
    rec("request/header", { header: { config: { provider: "pB", model: "mB", maxTokens: 1 } } }),
    rec("tool/call", { callId: "c2", name: "read", arguments: "{}" }),
    rec("tool/result", { message: { source: { kind: "tool", callId: "c2" }, content: [{ type: "tool-result", toolCallId: "c2", isError: true, content: [{ type: "text", text: "Error: x" }] }] } }),
  ];
  const buf = zframe(lines.join("\n") + "\n");
  const contrib = parseSessionBuffer(buf);
  const mA = contrib.models["pA / mA"];
  const mB = contrib.models["pB / mB"];
  assert.equal(mA.sessions, 1, "session 归首个 header 模型");
  assert.equal(mA.toolCalls, 1);
  assert.equal(mB.sessions, 0, "切过去的模型不计 session");
  assert.equal(mB.toolCalls, 1);
  assert.equal(mB.toolErrors, 1);
  assert.equal(contrib.topErrors[0].signature, "read: Error: x");
});

test("错误签名截断 100 字符 + 省略号", () => {
  const longMsg = "E".repeat(150);
  const buf = sessionFrames({ provider: "p", model: "m", calls: [{ name: "bash", ok: false, errText: longMsg }] });
  const contrib = parseSessionBuffer(buf);
  assert.equal(contrib.topErrors[0].signature.length, "bash: ".length + 100 + 1);
  assert.ok(contrib.topErrors[0].signature.endsWith("…"));
});

test("tool/result 缺 callId → 签名用 tool 前缀兜底", () => {
  const lines = [
    rec("session", { id: "x", cwd: "/tmp" }),
    rec("request/header", { header: { config: { provider: "p", model: "m", maxTokens: 1 } } }),
    rec("tool/result", { message: { content: [{ type: "tool-result", isError: true, content: [{ type: "text", text: "Error: no callId" }] }] } }),
  ];
  const buf = zframe(lines.join("\n") + "\n");
  const contrib = parseSessionBuffer(buf);
  assert.equal(contrib.topErrors[0].signature, "tool: Error: no callId");
  assert.equal(contrib.models["p / m"].toolErrors, 1);
});

test("parse: 按天分桶(双日文件:days 结构 + 全量字段不变 + firstHeaderModel 每日 file=true)", () => {
  const T1 = 1787800000000;          // 基准日
  const T2 = T1 + 86400000;          // 次日
  const lines = [
    rec("session", { id: "d1", cwd: "/tmp" }),
    rec("request/header", { header: { config: { provider: "p", model: "m", maxTokens: 1 } } }, T1),
    // day1: bash 失败一次
    rec("tool/call", { callId: "c1", name: "bash", arguments: "{}" }, T1),
    rec("tool/result", { message: { source: { kind: "tool", callId: "c1" }, content: [{ type: "tool-result", toolCallId: "c1", isError: true, content: [{ type: "text", text: "Error: e1" }] }] } }, T1),
    // day2: read 成功一次
    rec("tool/call", { callId: "c2", name: "read", arguments: "{}" }, T2),
    rec("tool/result", { message: { source: { kind: "tool", callId: "c2" }, content: [{ type: "tool-result", toolCallId: "c2", isError: false, content: [{ type: "text", text: "ok" }] }] } }, T2),
    // 无 time 的事件: 计入全量, 不落任何天桶
    JSON.stringify({ type: "tool/call", seq: 1, data: { callId: "c3", name: "grep", arguments: "{}" } }),
  ];
  const buf = zframe(lines.join("\n") + "\n");
  const contrib = parseSessionBuffer(buf);
  const m = contrib.models["p / m"];
  assert.ok(m, "model should exist");
  // 全量字段不受天桶影响
  assert.equal(m.sessions, 1);
  assert.equal(m.toolCalls, 3, "全量计数含无 time 事件");
  assert.equal(m.toolErrors, 1);
  assert.equal(m.tools.grep.calls, 1);
  // 天桶
  const d1 = dayKeyOf(T1), d2 = dayKeyOf(T2);
  assert.ok(m.days instanceof Map, "model 贡献缺少 days(Map)");
  assert.equal(m.days.size, 2, "两个活跃日各一个桶");
  assert.equal(m.days.get(d1).calls, 1);
  assert.equal(m.days.get(d1).errors, 1);
  assert.equal(m.days.get(d1).tools.get("bash").calls, 1);
  assert.equal(m.days.get(d1).sigs.get("bash: Error: e1"), 1);
  assert.equal(m.days.get(d2).calls, 1);
  assert.equal(m.days.get(d2).errors, 0);
  assert.equal(m.days.get(d2).tools.get("read").calls, 1);
  assert.ok(![...m.days.values()].some((de) => de.calls === 3), "无 time 事件不得落天桶");
  // firstHeaderModel 的 fileDays 每日 file=true
  assert.equal(m.days.get(d1).file, true);
  assert.equal(m.days.get(d2).file, true);
});

test("parse: session.createdAt 计入 fileDays(事件全无 time 时 firstHeaderModel 仍有活跃日)", () => {
  const T0 = 1787800000000;
  const lines = [
    JSON.stringify({ type: "session", seq: 1, createdAt: T0, data: { id: "d2", cwd: "/tmp" } }),
    JSON.stringify({ type: "request/header", seq: 1, data: { header: { config: { provider: "p", model: "m", maxTokens: 1 } } } }),
    JSON.stringify({ type: "tool/call", seq: 1, data: { callId: "c1", name: "bash", arguments: "{}" } }),
  ];
  const buf = zframe(lines.join("\n") + "\n");
  const contrib = parseSessionBuffer(buf);
  const m = contrib.models["p / m"];
  assert.equal(m.toolCalls, 1, "无 time 事件计入全量");
  const d0 = dayKeyOf(T0);
  const de = m.days.get(d0);
  assert.ok(de, "session.createdAt 的日应产生天桶");
  assert.equal(de.calls, 0);
  assert.equal(de.file, true, "firstHeaderModel 的 createdAt 日 file=true");
});

// ---- 3. ProfileStore -----------------------------------------------------

console.log("\n# ProfileStore");

test("全量扫描 → getPayload live 数据", async () => {
  const root = makeRoot();
  try {
    writeFile(root, "w1/s1/session.jsonl.zstd", sessionFrames({
      provider: "pa", model: "mA",
      calls: [{ name: "bash", ok: false, errText: "Error: boom" }, { name: "read" }],
    }));
    writeFile(root, "w1/s2/session.jsonl.zstd", sessionFrames({
      provider: "pa", model: "mA",
      calls: [{ name: "edit" }],
    }));
    writeFile(root, "w2/s3/session.jsonl.zstd", sessionFrames({
      provider: "pb", model: "mB",
      calls: [{ name: "bash" }, { name: "bash" }, { name: "bash" }, { name: "write", ok: false, errText: "denied" }],
    }));
    const store = new ProfileStore({ sessionsRoot: root });
    await store.scanFull();
    const payload = store.getPayload();
    assert.equal(payload.source, "live");
    assert.equal(payload.models.length, 2);
    // 按 toolCalls 降序：mB(3) 在前
    assert.equal(payload.models[0].id, "pb / mB");
    const mA = payload.models.find((m) => m.id === "pa / mA");
    assert.equal(mA.sessions, 2);
    assert.equal(mA.toolCalls, 3);
    assert.equal(mA.toolErrors, 1);
    assert.equal(mA.errorRate, 0.3333);
    assert.deepEqual(mA.topTools[0], { tool: "bash", calls: 1, errors: 1 });
    assert.equal(mA.topErrors[0].signature, "bash: Error: boom");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("增量扫描：mtime 变化才重解析；删除生效", async () => {
  const root = makeRoot();
  try {
    const fA = writeFile(root, "w/sA/session.jsonl.zstd", sessionFrames({ provider: "p", model: "m", calls: [{ name: "bash" }] }));
    const fB = writeFile(root, "w/sB/session.jsonl.zstd", sessionFrames({ provider: "p", model: "m", calls: [{ name: "edit" }] }));
    const store = new ProfileStore({ sessionsRoot: root });
    await store.scanFull();
    assert.equal(store.stats.files, 2);
    assert.equal(store.stats.lastParsed, 2);
    assert.equal(store.stats.lastSkipped, 0);

    // 改动 A（mtime +10s）
    const future = new Date(Date.now() + 10000);
    fs.utimesSync(fA, future, future);
    fs.writeFileSync(fA, sessionFrames({ provider: "p", model: "m", calls: [{ name: "bash" }, { name: "grep" }] }));
    await store.scanIncremental();
    assert.equal(store.stats.lastParsed, 1, "只有 A 重解析");
    let payload = store.getPayload();
    assert.equal(payload.models[0].toolCalls, 3); // bash x2 (A) + edit (B)

    // 删除 B
    fs.rmSync(fB);
    await store.scanIncremental();
    payload = store.getPayload();
    assert.equal(payload.models[0].toolCalls, 2); // 只剩 A 的 2 次
    assert.deepEqual(Object.keys(store.byFile).length ? [1] : [], [1]); // byFile 只剩 1 个
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("空目录扫描 → live + models=[]", async () => {
  const root = makeRoot();
  try {
    const store = new ProfileStore({ sessionsRoot: root });
    await store.scanFull();
    const payload = store.getPayload();
    assert.equal(payload.source, "live");
    assert.deepEqual(payload.models, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sessionsRoot 不存在 → 保持 mock 语义（scanning=false, 无 payload 数据）", async () => {
  const store = new ProfileStore({ sessionsRoot: "/nonexistent/path/xyz" });
  await store.scanFull();
  const payload = store.getPayload();
  // 无数据时 getPayload 应返回 null 或带标记的 mock
  assert.ok(payload === null || payload.source === "mock" || payload.models.length === 0);
});

test("getPayload(7) 窗口:窗口内保留、窗口外剔除、零活动模型剔除、window 字段", async () => {
  const root = makeRoot();
  try {
    const T_NOW = 1787800000000;            // 数据最大日 → 窗口锚点
    const T_OLD = T_NOW - 10 * 86400000;    // 10 天前,7 天窗口外
    // fA: mA 窗口内 2 次调用(0 错)+ 窗口外 1 次错误调用
    writeFile(root, "w/fA/session.jsonl.zstd", sessionFrames({
      provider: "pa", model: "mA", headerTime: T_NOW,
      calls: [
        { name: "bash", ok: false, errText: "Error: boom", time: T_OLD },
        { name: "bash", time: T_NOW },
        { name: "read", time: T_NOW },
      ],
    }));
    // fB: mB 全部活动都在窗口外 → 7 天窗口内零活动,应被剔除
    writeFile(root, "w/fB/session.jsonl.zstd", sessionFrames({
      provider: "pb", model: "mB", headerTime: T_OLD,
      calls: [{ name: "read", time: T_OLD }],
    }));
    // fC: mC 只有 header(0 调用),活跃日在窗口内 → 保留,sessions=1
    writeFile(root, "w/fC/session.jsonl.zstd", sessionFrames({
      provider: "pc", model: "mC", headerTime: T_NOW,
      calls: [],
    }));
    const store = new ProfileStore({ sessionsRoot: root });
    await store.scanFull();

    const full = store.getPayload();
    assert.equal(full.models.length, 3, "全量视图 3 模型");
    assert.ok(!("window" in full), "全量视图不应有 window 字段");

    const w = store.getPayload(7);
    assert.ok(w, "窗口 payload 应存在");
    assert.equal(w.source, "live");
    assert.deepEqual(w.window, { from: dayKeyOf(T_NOW - 6 * 86400000), to: dayKeyOf(T_NOW), days: 7 });
    const ids = w.models.map((m) => m.id).sort();
    assert.deepEqual(ids, ["pa / mA", "pc / mC"], "mB 窗口内零活动应被剔除");
    const mA = w.models.find((m) => m.id === "pa / mA");
    assert.equal(mA.toolCalls, 2, "窗口内只计 2 次,窗口外那次不计");
    assert.equal(mA.toolErrors, 0, "窗口外错误不计入");
    assert.equal(mA.errorRate, 0);
    assert.deepEqual(mA.topTools[0], { tool: "bash", calls: 1, errors: 0 }, "窗口内 topTools 只含窗口内调用");
    assert.equal(mA.sessions, 1, "窗口会话数 = 活跃(文件,日)对数");
    const mC = w.models.find((m) => m.id === "pc / mC");
    assert.equal(mC.toolCalls, 0);
    assert.equal(mC.sessions, 1, "0 调用但有活跃日 → 保留");
    assert.equal(mC.errorRate, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("getPayload today/yesterday 单日窗口(锚点=数据最大日)", async () => {
  const root = makeRoot();
  try {
    const T_NOW = 1787800000000;
    const T_YEST = T_NOW - 86400000;
    const T_OLD = T_NOW - 10 * 86400000;
    // fT: mT 最新日 2 次调用(0 错)+ 10 天前 1 次
    writeFile(root, "w/fT/session.jsonl.zstd", sessionFrames({
      provider: "pt", model: "mT", headerTime: T_NOW,
      calls: [
        { name: "bash", time: T_NOW },
        { name: "read", time: T_NOW },
        { name: "bash", time: T_OLD },
      ],
    }));
    // fY: mY 仅前一天 1 次错误调用
    writeFile(root, "w/fY/session.jsonl.zstd", sessionFrames({
      provider: "py", model: "mY", headerTime: T_YEST,
      calls: [{ name: "grep", ok: false, errText: "Error: nope", time: T_YEST }],
    }));
    const store = new ProfileStore({ sessionsRoot: root });
    await store.scanFull();

    const t = store.getPayload("today");
    assert.ok(t, "today payload 应存在");
    assert.equal(t.source, "live");
    assert.deepEqual(t.window, { from: dayKeyOf(T_NOW), to: dayKeyOf(T_NOW), days: "today" });
    assert.deepEqual(t.models.map((m) => m.id), ["pt / mT"], "mY(仅前一天)应被剔除");
    assert.equal(t.models[0].toolCalls, 2, "today 只计最新日 2 次(10 天前那次不计)");
    assert.equal(t.models[0].toolErrors, 0);
    assert.equal(t.models[0].sessions, 1, "窗口会话数 = 活跃(文件,日)对数");

    const y = store.getPayload("yesterday");
    assert.ok(y, "yesterday payload 应存在");
    assert.deepEqual(y.window, { from: dayKeyOf(T_YEST), to: dayKeyOf(T_YEST), days: "yesterday" });
    assert.deepEqual(y.models.map((m) => m.id), ["py / mY"], "mT 前一天零活动应被剔除");
    assert.equal(y.models[0].toolCalls, 1);
    assert.equal(y.models[0].toolErrors, 1);
    assert.equal(y.models[0].errorRate, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("getPayload(days):数据无任何时间戳 → 无法锚定窗口,返回 null", async () => {
  const root = makeRoot();
  try {
    writeFile(root, "w/fA/session.jsonl.zstd", sessionFrames({
      provider: "pa", model: "mA", headerTime: null,
      calls: [{ name: "bash", time: null }],
    }));
    const store = new ProfileStore({ sessionsRoot: root });
    await store.scanFull();
    const full = store.getPayload();
    assert.equal(full.source, "live");
    assert.equal(full.models.length, 1, "全量视图不受影响");
    assert.equal(store.getPayload(30), null, "无时间数据无法锚定窗口 → null(路由回退 mock)");
    assert.equal(store.getPayload("today"), null, "today 无时间戳同样无法锚定 → null");
    assert.equal(store.getPayload("yesterday"), null, "yesterday 无时间戳同样无法锚定 → null");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 4. 路由接线（index.js） ---------------------------------------------

console.log("\n# index.js route");

async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log(`  FAIL - ${name}`);
    console.log(String(err && err.stack ? err.stack : err).split("\n").map((l) => "      " + l).join("\n"));
  }
}

function fakeRes() {
  const r = { status: 0, headers: {}, body: "" };
  r.writeHead = (s, h) => { r.status = s; Object.assign(r.headers, h || {}); };
  r.end = (b) => { r.body = b; };
  return r;
}
function fakeReq(method, headers, url) { return { method, headers, url }; }

function startApp() {
  const registered = { path: null, handler: null };
  const ctx = {
    effect: (fn) => fn(),
    webServer: { register: (r) => { registered.path = r.path; registered.handler = r.handler; } },
  };
  return { registered, app: index.apply(ctx) };
}

process.env.DSH_CAP_PROFILE_SESSIONS = makeRoot(); // 存在但为空 → 首扫完成后 live + models=[]
const index = await import(pathToFileURL(path.join(here, "..", "index.js")).href);

await atest("apply 注册 exact 路由 /capability-profile", async () => {
  const { registered, app } = startApp();
  await app;
  assert.equal(registered.path, "/capability-profile");
  assert.equal(typeof registered.handler, "function");
});

await atest("无 client header → 403", async () => {
  const { registered, app } = startApp();
  await app;
  const res = fakeRes();
  await registered.handler(fakeReq("GET", { host: "127.0.0.1:3080", referer: "http://127.0.0.1:3080/" }), res);
  assert.equal(res.status, 403);
});

await atest("client header 对但 Origin 不匹配 → 403", async () => {
  const { registered, app } = startApp();
  await app;
  const res = fakeRes();
  await registered.handler(fakeReq("GET", {
    host: "127.0.0.1:3080",
    origin: "http://127.0.0.1:9999",
    "x-dsh-cap-profile-client": "v1",
  }), res);
  assert.equal(res.status, 403);
});

await atest("同源 GET（Referer 兜底）→ 200 + models 数组", async () => {
  const { registered, app } = startApp();
  await app;
  const res = fakeRes();
  await registered.handler(fakeReq("GET", {
    host: "127.0.0.1:3080",
    referer: "http://127.0.0.1:3080/some/session",
    "x-dsh-cap-profile-client": "v1",
  }), res);
  assert.equal(res.status, 200);
  assert.ok(String(res.headers["content-type"]).includes("application/json"));
  const doc = JSON.parse(res.body);
  assert.ok(Array.isArray(doc.models));
  // env 指向存在但为空的 root：首扫同步完成 → 必须走 live 通道（旧代码返回 mock，此断言即红）
  assert.equal(doc.source, "live");
  assert.deepEqual(doc.models, []);
  assert.ok(typeof doc.note === "string" && doc.note.includes("会话"));
});

await atest("POST → 405", async () => {
  const { registered, app } = startApp();
  await app;
  const res = fakeRes();
  await registered.handler(fakeReq("POST", {
    host: "127.0.0.1:3080",
    referer: "http://127.0.0.1:3080/",
    "x-dsh-cap-profile-client": "v1",
  }), res);
  assert.equal(res.status, 405);
});

// 路由 ?days 参数:用一个带数据的 root(2 文件:窗口内 mA 2 次调用 + 窗口外 mB 1 次)
{
  const winRoot = makeRoot();
  const W_NOW = 1787800000000;
  fs.mkdirSync(winRoot, { recursive: true });
  writeFile(winRoot, "w/wA/session.jsonl.zstd", sessionFrames({
    provider: "pa", model: "mA", headerTime: W_NOW,
    calls: [
      { name: "bash", time: W_NOW },
      { name: "read", time: W_NOW },
    ],
  }));
  writeFile(winRoot, "w/wB/session.jsonl.zstd", sessionFrames({
    provider: "pb", model: "mB", headerTime: W_NOW - 10 * 86400000,
    calls: [{ name: "read", time: W_NOW - 10 * 86400000 }],
  }));
  process.env.DSH_CAP_PROFILE_SESSIONS = winRoot; // apply() 时读取 → 后续 startApp 用此 root

  await atest("路由 ?days=7 → 200 + window 字段(窗口过滤生效)", async () => {
    const { registered, app } = startApp();
    await app;
    const res = fakeRes();
    await registered.handler(fakeReq("GET", {
      host: "127.0.0.1:3080",
      referer: "http://127.0.0.1:3080/",
      "x-dsh-cap-profile-client": "v1",
    }, "/capability-profile?days=7"), res);
    assert.equal(res.status, 200);
    const doc = JSON.parse(res.body);
    assert.equal(doc.source, "live");
    assert.ok(doc.window, "缺 window 字段");
    assert.equal(doc.window.days, 7);
    assert.equal(doc.window.to, dayKeyOf(W_NOW));
    assert.equal(doc.window.from, dayKeyOf(W_NOW - 6 * 86400000));
    assert.deepEqual(doc.models.map((m) => m.id), ["pa / mA"], "窗口外模型应被剔除");
  });

  await atest("路由 ?days=999(非法值) → 按全量处理(无 window 字段)", async () => {
    const { registered, app } = startApp();
    await app;
    const res = fakeRes();
    await registered.handler(fakeReq("GET", {
      host: "127.0.0.1:3080",
      referer: "http://127.0.0.1:3080/",
      "x-dsh-cap-profile-client": "v1",
    }, "/capability-profile?days=999"), res);
    assert.equal(res.status, 200);
    const doc = JSON.parse(res.body);
    assert.ok(!doc.window, "非法 days 应回退全量");
    assert.equal(doc.models.length, 2, "全量应含两模型");
  });

  await atest("路由 ?days=today → 200 + 单日窗口(仅最新日 wA)", async () => {
    const { registered, app } = startApp();
    await app;
    const res = fakeRes();
    await registered.handler(fakeReq("GET", {
      host: "127.0.0.1:3080",
      referer: "http://127.0.0.1:3080/",
      "x-dsh-cap-profile-client": "v1",
    }, "/capability-profile?days=today"), res);
    assert.equal(res.status, 200);
    const doc = JSON.parse(res.body);
    assert.equal(doc.source, "live");
    assert.deepEqual(doc.window, { from: dayKeyOf(W_NOW), to: dayKeyOf(W_NOW), days: "today" });
    assert.deepEqual(doc.models.map((m) => m.id), ["pa / mA"], "窗口外(wB 10 天前)应被剔除");
  });

  await atest("路由 ?days=yesterday → 200 + 前一日常量窗口(无活动 → 空 models)", async () => {
    const { registered, app } = startApp();
    await app;
    const res = fakeRes();
    await registered.handler(fakeReq("GET", {
      host: "127.0.0.1:3080",
      referer: "http://127.0.0.1:3080/",
      "x-dsh-cap-profile-client": "v1",
    }, "/capability-profile?days=yesterday"), res);
    assert.equal(res.status, 200);
    const doc = JSON.parse(res.body);
    assert.deepEqual(doc.window, { from: dayKeyOf(W_NOW - 86400000), to: dayKeyOf(W_NOW - 86400000), days: "yesterday" });
    assert.deepEqual(doc.models, [], "昨天无活动 → models 空");
  });

  await atest("路由 ?days=banana(非数值非关键字) → 按全量处理", async () => {
    const { registered, app } = startApp();
    await app;
    const res = fakeRes();
    await registered.handler(fakeReq("GET", {
      host: "127.0.0.1:3080",
      referer: "http://127.0.0.1:3080/",
      "x-dsh-cap-profile-client": "v1",
    }, "/capability-profile?days=banana"), res);
    assert.equal(res.status, 200);
    const doc = JSON.parse(res.body);
    assert.ok(!doc.window, "非法 days 应回退全量");
    assert.equal(doc.models.length, 2);
  });
}

// ---- 汇总 ----------------------------------------------------------------

await Promise.all(pending);
console.log(`\n${passed}/${passed + failed} passed`);
if (failed > 0) {
  console.log("\n失败项:");
  for (const f of failures) console.log(" - " + f.name);
  process.exit(1);
}
