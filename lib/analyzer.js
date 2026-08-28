/**
 * dsh-cap-profile P1 — 会话档案分析器（node 半）
 *
 * 设计定案要点：
 *  - Node 24 内置 zstd（zlib.zstdDecompressSync），但整 buffer 只解第一个 frame；
 *    会话文件 = 追加日志 = 多个拼接 frame → 魔数扫描逐 frame 解码。
 *  - 归属：最近一次在前面的 request/header 的 provider / model（currentModel 跟踪）。
 *  - isError 在 tool/result 的 data.message.content[] 里 type==="tool-result" 的 item 上。
 *  - 增量：per-file mtimeMs 基线（任何差异即变更，对时钟跳变/未来 mtime 免疫）；
 *    删除生效；文件集合剧烈变动 → 全量重扫自愈。
 *  - 零运行时依赖（node: 内置），ESM。
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]; // 小端 0xFD2FB528
const SESSION_FILE_NAME = "session.jsonl.zstd";
const SIGNATURE_LIMIT = 100;
const TOP_N = 5;
const YIELD_EVERY = 8; // 每解析 N 个文件让出一次事件循环
const FULL_REFRESH_MS = 24 * 60 * 60 * 1000; // 24h 全量自愈（时钟漂移）
const INCREMENTAL_MS = 60 * 1000; // 对齐 client 60s 刷新

// ---- 解码器 ---------------------------------------------------------------

/**
 * 多 frame zstd 解码：按魔数切 frame，逐帧 zstdDecompressSync，拼接输出。
 * 尾部撕裂帧（活动会话 append 写到一半）静默跳过，下次增量自愈。
 */
export function decodeZstdFrames(buf) {
  const out = [];
  const n = buf.length;
  let i = 0;
  while (i < n) {
    // 找下一个 frame 起点
    let idx = -1;
    for (;;) {
      idx = buf.indexOf(ZSTD_MAGIC[0], i);
      if (idx < 0 || idx + 4 > n) break;
      if (buf[idx + 1] === ZSTD_MAGIC[1] && buf[idx + 2] === ZSTD_MAGIC[2] && buf[idx + 3] === ZSTD_MAGIC[3]) break;
      i = idx + 1;
    }
    if (idx < 0) break;
    // 找再下一个 frame 起点（本 frame 的终点）
    let next = n;
    for (let j = idx + 4; j + 4 <= n; j++) {
      if (buf[j] === ZSTD_MAGIC[0] && buf[j + 1] === ZSTD_MAGIC[1] && buf[j + 2] === ZSTD_MAGIC[2] && buf[j + 3] === ZSTD_MAGIC[3]) {
        next = j;
        break;
      }
    }
    try {
      out.push(zlib.zstdDecompressSync(buf.subarray(idx, next)));
    } catch {
      /* 撕裂/坏帧：跳过 */
    }
    i = next > idx ? next : idx + 4;
  }
  return Buffer.concat(out);
}

// ---- 单文件解析 -----------------------------------------------------------

const ANSI_RE = /\u001b\[[0-9;]*[A-Za-z]/g;

/** 错误签名 = `${toolName}: ${错误文本首行}`（去 ANSI、压空白、截 100 字符 + "…"）。 */
function errorSignature(toolName, text) {
  let line = "";
  if (typeof text === "string") {
    line = text.split("\n", 1)[0].replace(ANSI_RE, "").replace(/\s+/g, " ").trim();
    if (line.length > SIGNATURE_LIMIT) line = line.slice(0, SIGNATURE_LIMIT) + "…";
  }
  return `${toolName || "tool"}: ${line || "未知错误"}`;
}

function resultText(item) {
  let text = "";
  if (Array.isArray(item.content)) {
    for (const c of item.content) if (c && c.type === "text" && typeof c.text === "string") text += c.text;
  }
  return text;
}

/** 本地日历日 YYYY-MM-DD(窗口锚点用数据自带时间戳,不用 Date.now —— 本机时钟漂移)。 */
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** dayKey("YYYY-MM-DD") 向前退 n 天的 key(本地日历运算)。 */
function dayKeyShifted(key, minusDays) {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d - minusDays).getTime());
}

function dayEntry(m, dk) {
  let de = m.days.get(dk);
  if (!de) {
    de = { calls: 0, errors: 0, file: false, tools: new Map(), sigs: new Map() };
    m.days.set(dk, de);
  }
  return de;
}

/**
 * 解析一个会话文件（压缩 buffer）→ 本文件的 per-model 贡献。
 * 返回 { models: { [modelId]: { sessions, toolCalls, toolErrors,
 *               tools: {name:{calls,errors}}, errors: Map<sig,count>,
 *               days: Map<dayKey,{calls,errors,file,tools:Map,sigs:Map}> } },
 *        topTools: [{tool,calls,errors}]（全量，降序）, topErrors: [{signature,count}]（全量，降序） }
 *
 * P1.5 天桶（DESIGN §8.6）：
 *  - fileDays = 任意事件顶层 o.time + session 记录 o.data.createdAt 的本地日历日；
 *  - tool/call、tool/result 按各自 o.time 落所属模型的天桶（无 time → 只计全量）；
 *  - firstHeaderModel 的每个 fileDays 日置 file=true（「活跃会话日」判据）。
 */
export function parseSessionBuffer(buf) {
  const text = decodeZstdFrames(buf).toString("utf8");
  const models = {};
  let curModel = null;
  let firstHeaderModel = null;
  const callNames = new Map(); // callId -> tool name（按文件）
  const fileDays = new Set();

  const model = (id) => {
    if (!models[id]) models[id] = { sessions: 0, toolCalls: 0, toolErrors: 0, tools: {}, errors: new Map(), days: new Map() };
    return models[id];
  };

  for (const line of text.split("\n")) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const d = o.data;
    const ts = typeof o.time === "number" ? o.time : null;
    if (o.type === "session") {
      // session 记录不带 o.time(实测):用 createdAt(顶层,epoch ms)记文件创建日
      const created = typeof o.createdAt === "number" ? o.createdAt
        : (d && typeof d.createdAt === "number" ? d.createdAt : null);
      if (created !== null) fileDays.add(dayKey(created));
    } else if (ts !== null) {
      fileDays.add(dayKey(ts));
    }
    if (o.type === "request/header") {
      const cfg = d && d.header && d.header.config;
      if (cfg && cfg.provider && cfg.model) {
        curModel = `${cfg.provider} / ${cfg.model}`;
        if (firstHeaderModel === null) firstHeaderModel = curModel;
      }
    } else if (o.type === "tool/call") {
      const name = d && d.name;
      const cid = d && d.callId;
      if (cid && name) callNames.set(cid, name);
      if (!curModel) continue; // 首个 header 之前的 call 无法归属（实测仅 10 个文件，丢弃）
      const m = model(curModel);
      m.toolCalls++;
      if (name) {
        if (!m.tools[name]) m.tools[name] = { calls: 0, errors: 0 };
        m.tools[name].calls++;
      }
      if (ts !== null) {
        const de = dayEntry(m, dayKey(ts));
        de.calls++;
        if (name) {
          const t = de.tools.get(name) || { calls: 0, errors: 0 };
          t.calls++;
          de.tools.set(name, t);
        }
      }
    } else if (o.type === "tool/result") {
      const c = d && d.message && d.message.content;
      let item = null;
      if (Array.isArray(c)) for (const it of c) if (it && it.type === "tool-result") { item = it; break; }
      if (!item || !item.isError) continue;
      if (!curModel) continue;
      const name = item.toolCallId ? callNames.get(item.toolCallId) : undefined;
      const m = model(curModel);
      m.toolErrors++;
      if (name) {
        if (!m.tools[name]) m.tools[name] = { calls: 0, errors: 0 };
        m.tools[name].errors++;
      }
      const sig = errorSignature(name, resultText(item));
      m.errors.set(sig, (m.errors.get(sig) || 0) + 1);
      if (ts !== null) {
        const de = dayEntry(m, dayKey(ts));
        de.errors++;
        if (name) {
          const t = de.tools.get(name) || { calls: 0, errors: 0 };
          t.errors++;
          de.tools.set(name, t);
        }
        de.sigs.set(sig, (de.sigs.get(sig) || 0) + 1);
      }
    }
  }

  // 会话数归文件首个 request/header 的模型；其活跃日（fileDays）全部 file=true
  if (firstHeaderModel !== null) {
    const fm = model(firstHeaderModel);
    fm.sessions++;
    for (const dk of fileDays) dayEntry(fm, dk).file = true;
  }

  // 每个模型补 errorRate（4 位小数）
  for (const m of Object.values(models)) {
    m.errorRate = m.toolCalls ? Math.round((m.toolErrors / m.toolCalls) * 10000) / 10000 : 0;
  }

  // 全量 top 列表（跨模型合并；store 级再做 top N 截断）
  const topTools = Object.values(models).flatMap((m) =>
    Object.entries(m.tools).map(([tool, x]) => ({ tool, calls: x.calls, errors: x.errors }))
  ).sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  const topErrors = Object.values(models).flatMap((m) =>
    [...m.errors.entries()].map(([signature, count]) => ({ signature, count }))
  ).sort((a, b) => b.count - a.count || a.signature.localeCompare(b.signature));

  return { models, topTools, topErrors };
}

// ---- 扫描 store -----------------------------------------------------------

function listSessionFiles(root) {
  const out = [];
  (function walk(d) {
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name === SESSION_FILE_NAME) out.push(p);
    }
  })(root);
  return out;
}

const yieldToLoop = () => new Promise((r) => setImmediate(r));

export class ProfileStore {
  constructor({ sessionsRoot }) {
    this.sessionsRoot = sessionsRoot;
    /** @type {{[file: string]: {mtimeMs: number, models: object}}} */
    this.byFile = {};
    this.scanning = false;
    /** @type {?{generatedAt: string, fileCount: number, models: Map<string, object>}} */
    this.live = null;
    this.lastError = null;
    this.stats = { files: 0, lastParsed: 0, lastSkipped: 0, fullScans: 0, incrementalScans: 0 };
  }

  _parseFile(p) {
    return parseSessionBuffer(fs.readFileSync(p));
  }

  /** 全量扫描。root 不存在 → 不动缓存、记 lastError。 */
  async scanFull() {
    if (this.scanning) return;
    if (!fs.existsSync(this.sessionsRoot)) {
      this.lastError = `sessions root missing: ${this.sessionsRoot}`;
      return;
    }
    this.scanning = true;
    this.lastError = null;
    try {
      const files = listSessionFiles(this.sessionsRoot);
      const byFile = {};
      let parsed = 0;
      for (let i = 0; i < files.length; i++) {
        const p = files[i];
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        byFile[p] = { mtimeMs: st.mtimeMs, models: this._parseFile(p).models };
        parsed++;
        if ((i + 1) % YIELD_EVERY === 0) await yieldToLoop();
      }
      this.byFile = byFile;
      this._rebuild();
      this.stats.files = files.length;
      this.stats.lastParsed = parsed;
      this.stats.lastSkipped = 0;
      this.stats.fullScans++;
    } catch (err) {
      this.lastError = String((err && err.message) || err);
    } finally {
      this.scanning = false;
    }
  }

  /** 增量扫描：mtimeMs 任何差异即重解析；删除生效；集合剧烈变动 → 全部重解析（自愈）。 */
  async scanIncremental() {
    if (this.scanning) return;
    if (!fs.existsSync(this.sessionsRoot)) {
      this.lastError = `sessions root missing: ${this.sessionsRoot}`;
      return;
    }
    this.scanning = true;
    this.lastError = null;
    try {
      const files = listSessionFiles(this.sessionsRoot);
      const fileSet = new Set(files);
      const prevKeys = Object.keys(this.byFile);
      const removed = prevKeys.filter((p) => !fileSet.has(p)).length;
      const drastic = removed > Math.max(8, Math.floor(prevKeys.length / 2));
      const next = {};
      let parsed = 0, skipped = 0;
      for (let i = 0; i < files.length; i++) {
        const p = files[i];
        let st;
        try { st = fs.statSync(p); } catch { continue; }
        const prev = this.byFile[p];
        if (!drastic && prev && prev.mtimeMs === st.mtimeMs) {
          next[p] = prev;
          skipped++;
        } else {
          next[p] = { mtimeMs: st.mtimeMs, models: this._parseFile(p).models };
          parsed++;
        }
        if ((i + 1) % YIELD_EVERY === 0) await yieldToLoop();
      }
      this.byFile = next;
      this._rebuild();
      this.stats.files = files.length;
      this.stats.lastParsed = parsed;
      this.stats.lastSkipped = skipped;
      this.stats.incrementalScans++;
    } catch (err) {
      this.lastError = String((err && err.message) || err);
    } finally {
      this.scanning = false;
    }
  }

  _rebuild() {
    const agg = new Map();
    for (const p of Object.keys(this.byFile)) {
      const models = this.byFile[p].models;
      for (const [id, m] of Object.entries(models)) {
        let a = agg.get(id);
        if (!a) {
          a = { sessions: 0, toolCalls: 0, toolErrors: 0, tools: new Map(), errors: new Map(), days: new Map() };
          agg.set(id, a);
        }
        a.sessions += m.sessions || 0;
        a.toolCalls += m.toolCalls;
        a.toolErrors += m.toolErrors;
        for (const [t, x] of Object.entries(m.tools)) {
          const e = a.tools.get(t) || { calls: 0, errors: 0 };
          e.calls += x.calls;
          e.errors += x.errors;
          a.tools.set(t, e);
        }
        for (const [s, c] of m.errors) a.errors.set(s, (a.errors.get(s) || 0) + c);
        // 天桶合并:窗口会话数 = 活跃(文件,日)对数(tool 事件日 或 firstHeaderModel 活跃日)
        for (const [dk, de] of (m.days || new Map())) {
          let ae = a.days.get(dk);
          if (!ae) {
            ae = { sessions: 0, calls: 0, errors: 0, file: false, tools: new Map(), sigs: new Map() };
            a.days.set(dk, ae);
          }
          if (de.calls > 0 || de.file) ae.sessions++;
          ae.calls += de.calls;
          ae.errors += de.errors;
          ae.file = ae.file || de.file;
          for (const [t, x] of de.tools.entries()) {
            const e = ae.tools.get(t) || { calls: 0, errors: 0 };
            e.calls += x.calls;
            e.errors += x.errors;
            ae.tools.set(t, e);
          }
          for (const [s, c] of de.sigs.entries()) ae.sigs.set(s, (ae.sigs.get(s) || 0) + c);
        }
      }
    }
    // 窗口锚点 = 数据中最大日(不用 Date.now,对时钟漂移免疫);YYYY-MM-DD 字符串可比
    let maxDay = null;
    for (const a of agg.values()) {
      for (const dk of a.days.keys()) if (maxDay === null || dk > maxDay) maxDay = dk;
    }
    this.live = {
      generatedAt: new Date().toISOString(),
      fileCount: Object.keys(this.byFile).length,
      models: agg,
      maxDay,
    };
  }

  /**
   * range: 0/undefined → 全量(payload 无 window 字段);
   * 7/30/90 → 近 N 天窗口 [maxDay − (N−1) 天, maxDay];
   * "today" → [maxDay, maxDay];"yesterday" → [maxDay−1 天, maxDay−1 天]
   * (锚点=数据最大日,时钟漂移免疫,与近 N 天一致)。
   * 无 live 数据或无法锚定窗口(无任何时间戳)→ null(调用方回退 mock)。
   */
  getPayload(range) {
    if (!this.live) return null;
    let from = null;
    let to = null;
    let winLabel = 0;
    if (range === "today" || range === "yesterday") {
      if (!this.live.maxDay) return null;
      const anchor = range === "today" ? this.live.maxDay : dayKeyShifted(this.live.maxDay, 1);
      to = anchor;
      from = anchor;
      winLabel = range;
    } else {
      const winDays = Number.isFinite(range) && range > 0 ? Math.floor(range) : 0;
      if (winDays > 0) {
        if (!this.live.maxDay) return null;
        to = this.live.maxDay;
        from = dayKeyShifted(to, winDays - 1);
        winLabel = winDays;
      }
    }
    if (winLabel !== 0) {
      const models = [];
      for (const [id, m] of this.live.models.entries()) {
        let sessions = 0, toolCalls = 0, toolErrors = 0;
        const tools = new Map();
        const sigs = new Map();
        for (const [dk, de] of m.days) {
          if (dk < from || dk > to) continue;
          sessions += de.sessions;
          toolCalls += de.calls;
          toolErrors += de.errors;
          for (const [t, x] of de.tools) {
            const e = tools.get(t) || { calls: 0, errors: 0 };
            e.calls += x.calls;
            e.errors += x.errors;
            tools.set(t, e);
          }
          for (const [s, c] of de.sigs) sigs.set(s, (sigs.get(s) || 0) + c);
        }
        if (toolCalls === 0 && sessions === 0) continue; // 窗口内零活动 → 剔除
        const topTools = [...tools.entries()]
          .sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))
          .slice(0, TOP_N)
          .map(([tool, x]) => ({ tool, calls: x.calls, errors: x.errors }));
        const topErrors = [...sigs.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .slice(0, TOP_N)
          .map(([signature, count]) => ({ signature, count }));
        models.push({
          id,
          sessions,
          toolCalls,
          toolErrors,
          errorRate: toolCalls ? Math.round((toolErrors / toolCalls) * 10000) / 10000 : 0,
          topTools,
          topErrors,
        });
      }
      models.sort((a, b) => b.toolCalls - a.toolCalls || a.id.localeCompare(b.id));
      const note = [
        `数据源 ${this.sessionsRoot}`,
        `窗口 ${from === to ? from : from + " ~ " + to}`,
        `${models.length} 模型`,
      ];
      if (this.scanning) note.push("扫描中…");
      return {
        source: "live",
        generatedAt: this.live.generatedAt,
        note: note.join(" · "),
        models,
        window: { from, to, days: winLabel },
      };
    }
    const models = [...this.live.models.entries()].map(([id, m]) => {
      const topTools = [...m.tools.entries()]
        .sort((a, b) => b[1].calls - a[1].calls || a[0].localeCompare(b[0]))
        .slice(0, TOP_N)
        .map(([tool, x]) => ({ tool, calls: x.calls, errors: x.errors }));
      const topErrors = [...m.errors.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, TOP_N)
        .map(([signature, count]) => ({ signature, count }));
      return {
        id,
        sessions: m.sessions,
        toolCalls: m.toolCalls,
        toolErrors: m.toolErrors,
        errorRate: m.toolCalls ? Math.round((m.toolErrors / m.toolCalls) * 10000) / 10000 : 0,
        topTools,
        topErrors,
      };
    }).sort((a, b) => b.toolCalls - a.toolCalls || a.id.localeCompare(b.id));

    const note = [
      `数据源 ${this.sessionsRoot}`,
      `${this.live.fileCount} 会话`,
      `${models.length} 模型`,
    ];
    if (this.scanning) note.push("扫描中…");
    return {
      source: "live",
      generatedAt: this.live.generatedAt,
      note: note.join(" · "),
      models,
    };
  }

  /** apply() 调用：首扫 + 60s 增量 + 24h 全量自愈（全部 unref，不挡进程退出）。 */
  start() {
    this.scanFull().catch((err) => { this.lastError = String((err && err.message) || err); });
    const ivIncremental = setInterval(() => {
      this.scanIncremental().catch((err) => { this.lastError = String((err && err.message) || err); });
    }, INCREMENTAL_MS);
    ivIncremental.unref();
    const ivFull = setInterval(() => {
      this.scanFull().catch((err) => { this.lastError = String((err && err.message) || err); });
    }, FULL_REFRESH_MS);
    ivFull.unref();
  }
}
