/**
 * dsh-cap-profile — 模型能力画像(browser 半)
 *
 * 会话区 conversation.view tab「能力画像」:只读观察窗。数据经宿主同源路由
 * GET /capability-profile 拉取(宿主侧直接读 ~/.dsh/sessions,无 live agent
 * 依赖,冷会话可用)—— dsh-web-review 同源路由模式。
 *
 * 手写 CJS factory,经 window.__ModuleLoader__.load 注册。
 * ★ banner id 必须等于 cordis 行的 entry name:
 *   - 正式通道(当前): "dsh-cap-profile"(cordis.patch.yml 装入 profile)
 *   - dev 通道(已废弃): "@dsh-cap-profile-dev/plugin"(--patch overlay 与正式条目
 *     重复 → duplicate loader entry,勿再用)
 *
 * 样式(v2,与 dsh-model-manager「模型管理」面板同款设计语言,白底):
 *   GitHub-light token(#ffffff / #eef1f5 / #d0d7de / #0969da …)、
 *   320px 1fr 两 Pane(左:搜索 + 按 provider 分组模型列表;右:详情)、
 *   pill / tabular-nums / bordered table / 0.12s 微交互、
 *   focus-visible / reduced-motion / 窄列单列降级。
 *
 * 数据契约(渲染层只依赖这些字段,P1 同形状即直接渲染):
 *   { source, generatedAt, note,
 *     models: [{ id: "provider / model", sessions, toolCalls, toolErrors,
 *               errorRate(0-1), topTools: [{tool, calls, errors}],
 *               topErrors: [{signature, count}],
 *               tools: [{tool, calls, errors}],   // P2.0 可选:每模型 Top-10 全量工具(对比矩阵用)
 *               series: [{d, calls, errors}] }] } // P2.0 可选:逐日调用/错误(对比趋势用,d=YYYY-MM-DD 升序)
 *   缺失字段兜底:topTools/topErrors 空→"(无)",errorRate 非数字→"—",
 *   id 无 " / " 分隔→整串为模型名、provider 归"(未知)"。
 *   P2.0 对比:models[].tools 缺失→矩阵回落 topTools;series 全空→趋势块整体不渲染。
 *
 * client 半改动仅 F5 生效(node 半不动)。
 */
window.__ModuleLoader__.load({
  id: "dsh-cap-profile",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");
    const e = React.createElement;

    const REFRESH_MS = 60000;
    const PROFILE_PATH = "/capability-profile";
    const CLIENT_HEADER = "x-dsh-cap-profile-client";
    const CLIENT_HEADER_VALUE = "v1";

    /* 模块级缓存:切 tab 导致面板卸载重挂载时,首屏直渲上次数据(带旧时间戳),
       后台静默 revalidate —— 消除「正在读取会话档案…」闪烁(模型管理同款先例)。 */
    let cachedDoc = null;
    let cachedAt = null;
    let cachedSortKey = "calls"; // 排序选择也模块级:重挂载(切 tab)保持用户选的排序
    let cachedRangeDays = "0"; // 时间范围也模块级("0"=全部 / "today" / "yesterday" / "7"/"30"/"90",select 原始字符串),同 P0.5 缓存先例
    let cachedCompareIds = []; // P2.0:对比勾选(模型 id 数组,最多 4 个)也模块级:重挂载(切 tab)保持勾选,搜索/时间窗变化不清空
    let cachedViewMode = "detail"; // P2.0:"detail" | "compare";同样模块级持久

    /* ---------- 样式(白底,token 与模型管理面板同值;作用域 .cp-root) ---------- */

    const CSS = `
.cp-root{
  --bg:#ffffff; --page:#eef1f5; --layer:#f6f8fa; --layer2:#eef1f4; --line:#d0d7de; --line2:#b6bec7;
  --text:#1f2328; --muted:#57606a; --faint:#8c959f;
  --accent:#0969da; --success:#1a7f37; --warn:#9a6700; --danger:#cf222e;
  --hover:rgba(175,184,193,.22);
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --code:ui-monospace,SFMono-Regular,"JetBrains Mono",Consolas,monospace;
  display:flex;flex-direction:column;height:100%;min-height:0;padding:0;
  background:var(--bg);color:var(--text);font-family:var(--font);font-size:12.5px;line-height:1.5;
}
.cp-root *{box-sizing:border-box;margin:0;padding:0;}
.cp-root button,.cp-root input{font-family:var(--font);}
.cp-root :focus-visible{outline:2px solid var(--accent);outline-offset:1px;}

/* 页头(标题 + pill + 刷新 / meta 行) */
.cp-head{padding:14px 16px 12px;border-bottom:1px solid var(--line);display:flex;flex-direction:column;gap:8px;flex:none;}
.cp-headRow{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.cp-title{font-size:14px;font-weight:600;}
.cp-spacer{flex:1;}
.cp-meta{color:var(--faint);font-size:11px;font-variant-numeric:tabular-nums;}
.cp-btn{
  min-height:30px;padding:4px 12px;border:1px solid var(--line2);border-radius:8px;
  background:var(--bg);color:var(--text);font-size:12px;cursor:pointer;white-space:nowrap;
  transition:background-color .12s,border-color .12s,transform .12s;
}
.cp-btn:hover:not(:disabled){background:var(--hover);}
.cp-btn:active:not(:disabled){transform:translateY(1px);}
.cp-btn:disabled{opacity:.4;cursor:default;}

/* pill 徽章 */
.cp-pill{
  display:inline-flex;align-items:center;gap:5px;min-height:22px;padding:0 9px;
  border:1px solid var(--line);border-radius:999px;background:var(--layer);
  color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap;
}
.cp-pill b{font-weight:600;color:var(--text);}
.cp-pill--ok{border-color:color-mix(in srgb,var(--success) 34%,var(--line));color:var(--success);background:color-mix(in srgb,var(--success) 7%,var(--bg));}
.cp-pill--ok b{color:var(--success);}
.cp-pill--warn{border-color:color-mix(in srgb,var(--warn) 40%,var(--line));color:var(--warn);background:color-mix(in srgb,var(--warn) 8%,var(--bg));}
.cp-pill--warn b{color:var(--warn);}
.cp-pill--fail{border-color:color-mix(in srgb,var(--danger) 42%,var(--line));color:var(--danger);background:color-mix(in srgb,var(--danger) 6%,var(--bg));}
.cp-pill--fail b{color:var(--danger);}

/* 主体:320px 列表 + 详情 */
.cp-body{flex:1;min-height:0;display:grid;grid-template-columns:320px 1fr;}
.cp-paneL{border-right:1px solid var(--line);padding:10px 8px;overflow:auto;background:color-mix(in srgb,var(--layer) 55%,var(--bg));min-width:0;}
.cp-paneR{padding:12px 16px 16px;overflow:auto;min-width:0;}
.cp-fade{animation:cpFade .15s ease-out;}
@keyframes cpFade{from{opacity:.55}to{opacity:1}}

/* 左:搜索 + 分组模型行 */
.cp-search{width:calc(100% - 8px);margin:0 0 10px;padding:5px 10px;border:1px solid var(--line2);border-radius:8px;background:var(--bg);color:var(--text);font-size:12px;}
.cp-search:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 18%,transparent);}
.cp-search::placeholder{color:var(--faint);}
.cp-kickerRow{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px 4px;min-width:0;}
.cp-kicker{font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--muted);font-variant-numeric:tabular-nums;min-width:0;}
.cp-sort{
  flex:none;max-width:120px;padding:2px 6px;border:1px solid var(--line2);border-radius:6px;
  background:var(--bg);color:var(--muted);font-size:11px;cursor:pointer;
  transition:background-color .12s,border-color .12s;
}
.cp-sort:hover{background:var(--hover);}
.cp-filters{display:flex;gap:8px;padding:2px 8px 6px;}
.cp-filters .cp-sort{flex:1;max-width:none;width:auto;}
.cp-mGroup{margin-bottom:10px;}
.cp-mHead{padding:4px 8px;display:flex;gap:6px;align-items:center;min-width:0;}
.cp-mHeadCode{font-family:var(--code);font-size:10.5px;color:var(--faint);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;}
.cp-row{
  width:100%;display:flex;align-items:center;gap:7px;padding:6px 8px;
  border:1px solid transparent;border-radius:7px;background:transparent;
  cursor:pointer;text-align:left;min-width:0;color:var(--muted);font-size:11.5px;
  transition:background-color .12s,border-color .12s;
}
.cp-row:hover{background:var(--hover);}
.cp-row--sel{background:var(--bg);border-color:var(--line);box-shadow:0 1px 2px rgba(31,35,40,.06);}
.cp-rowName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--code);font-size:11.5px;color:var(--muted);}
.cp-row--sel .cp-rowName{color:var(--text);}
.cp-row .cp-pill{min-height:18px;padding:0 7px;font-size:10.5px;line-height:16px;flex:none;}
.cp-rowN{flex:none;font-family:var(--code);font-size:10px;color:var(--faint);font-variant-numeric:tabular-nums;}
.cp-emptyL{padding:20px 8px;font-size:11.5px;color:var(--faint);text-align:center;}

/* 右:详情 */
.cp-vHead{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.cp-vTitle{font-family:var(--code);font-size:13.5px;font-weight:600;word-break:break-all;line-height:1.4;}
.cp-pills{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;}
.cp-note{margin-top:10px;border:1px solid var(--line);border-radius:8px;background:var(--layer);padding:7px 12px;font-size:11.5px;color:var(--muted);line-height:1.5;word-break:break-word;}
.cp-secLabel{font-size:11px;font-weight:600;letter-spacing:.06em;color:var(--muted);margin:16px 0 6px;}

/* 常用工具表:排名 | 工具 | 占比条 | 调用 | 错误 */
.cp-table{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg);}
.cp-tHead{display:grid;grid-template-columns:20px minmax(0,1fr) 90px 52px 48px 56px;padding:6px 10px;background:var(--layer);border-bottom:1px solid var(--line);font-size:11px;color:var(--faint);align-items:center;}
.cp-tRow{display:grid;grid-template-columns:20px minmax(0,1fr) 90px 52px 48px 56px;align-items:center;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);padding:5px 10px;min-width:0;}
.cp-tRow:last-child{border-bottom:none;}
.cp-tRow:hover{background:color-mix(in srgb,var(--hover) 55%,transparent);}
.cp-rank{font-family:var(--code);font-size:10.5px;color:var(--faint);font-variant-numeric:tabular-nums;}
.cp-toolName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--code);font-size:11px;color:var(--text);}
.cp-bar{height:6px;border-radius:3px;background:var(--layer2);overflow:hidden;}
.cp-barFill{height:100%;border-radius:3px;background:var(--accent);}
.cp-num{font-size:11.5px;color:var(--text);text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
.cp-num--err{color:var(--danger);}
.cp-num--zero{color:var(--faint);}
.cp-num--warn{color:var(--warn);}
.cp-num--fail{color:var(--danger);}
.cp-c{text-align:center;}
.cp-emptyRow{padding:8px 10px;font-size:11.5px;color:var(--faint);}

/* 高频错误签名表:排名 | 签名 | 次数 */
.cp-eHead{display:grid;grid-template-columns:20px minmax(0,1fr) 64px;padding:6px 10px;background:var(--layer);border-bottom:1px solid var(--line);font-size:11px;color:var(--faint);align-items:baseline;}
.cp-eRow{display:grid;grid-template-columns:20px minmax(0,1fr) 64px;align-items:baseline;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);padding:5px 10px;min-width:0;}
.cp-eRow:last-child{border-bottom:none;}
.cp-eRow:hover{background:color-mix(in srgb,var(--hover) 55%,transparent);}
.cp-sig{min-width:0;font-family:var(--code);font-size:11px;color:var(--muted);word-break:break-all;line-height:1.45;padding:0 4px;}
.cp-r{text-align:right;}

/* P2.0 compare view */
.cp-rowWrap{display:flex;align-items:center;gap:3px;min-width:0;}
.cp-cmpBox{flex:none;display:flex;align-items:center;padding:1px 2px;cursor:pointer;}
.cp-cmpBox input{width:13px;height:13px;cursor:pointer;accent-color:var(--accent);}
.cp-cmpBox input:disabled{cursor:default;}
.cp-btnCmp{border-color:color-mix(in srgb,var(--accent) 45%,var(--line2));color:var(--accent);background:color-mix(in srgb,var(--accent) 6%,var(--bg));}
.cp-btnCmp:hover:not(:disabled){background:color-mix(in srgb,var(--accent) 12%,var(--bg));}
.cp-cmpGrid{display:grid;align-items:center;border-bottom:1px solid color-mix(in srgb,var(--line) 55%,transparent);padding:5px 10px;min-width:0;}
.cp-cmpGrid:last-child{border-bottom:none;}
.cp-cmpHead{background:var(--layer);border-bottom:1px solid var(--line);font-size:11px;color:var(--faint);}
.cp-cmpLabel{font-size:11px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
/* compare tables: no overflow clipping (sticky head needs a scrollable ancestor) */
.cp-cmpTbl{overflow:visible;}
.cp-cmpTbl>.cp-cmpHead{position:sticky;top:0;z-index:2;border-radius:8px 8px 0 0;}
.cp-cmpTbl>.cp-cmpGrid:last-child{border-radius:0 0 8px 8px;}
/* column header: provider row (column color) + model row; click = open that model */
.cp-cmpCol{display:flex;flex-direction:column;align-items:flex-end;gap:1px;padding-top:5px;border-top:2px solid var(--line2);cursor:pointer;min-width:0;}
.cp-cmpCol:hover .cp-cmpColName{color:var(--accent);}
.cp-cmpColProv{font-family:var(--code);font-size:10px;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}
.cp-cmpColName{font-family:var(--code);font-size:11px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%;}
.cp-cmpTool{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--code);font-size:11px;color:var(--text);}
.cp-cmpSig{min-width:0;font-family:var(--code);font-size:11px;color:var(--muted);word-break:break-all;line-height:1.45;padding:0 4px;}
.cp-cmpDay{font-family:var(--code);font-size:11px;color:var(--muted);}
.cp-num--top{font-weight:600;color:var(--accent);}
.cp-num--best{color:var(--success);}
.cp-num--worst{color:var(--danger);}
.cp-tCell{display:flex;align-items:center;justify-content:flex-end;gap:6px;min-width:0;}
.cp-tBar{flex:1;max-width:110px;height:7px;border-radius:3.5px;background:var(--layer2);overflow:hidden;}
.cp-tBarFill{height:100%;border-radius:3.5px;background:var(--accent);opacity:.8;}
.cp-tNum{flex:none;font-size:11px;color:var(--text);font-variant-numeric:tabular-nums;}
.cp-tErr{flex:none;font-size:10.5px;color:var(--danger);font-variant-numeric:tabular-nums;}
.cp-btnMini{min-height:24px;padding:2px 10px;font-size:11px;display:block;margin:4px auto 6px;}

/* 提示条 / 加载 / 空态 */
.cp-flash{margin-bottom:10px;padding:7px 12px;border-radius:8px;border:1px solid color-mix(in srgb,var(--danger) 34%,var(--line));background:color-mix(in srgb,var(--danger) 6%,var(--bg));color:var(--danger);font-size:12px;word-break:break-all;}
.cp-loading{padding:48px 0;text-align:center;font-size:12px;color:var(--faint);}
.cp-empty{padding:48px 16px;text-align:center;}
.cp-emptyTitle{font-size:13px;font-weight:500;color:var(--muted);margin-bottom:6px;}
.cp-emptyHint{font-size:12px;line-height:1.7;color:var(--faint);max-width:46ch;margin:0 auto;}

/* 窄列降级:单列,列表置顶 */
@media (max-width:860px){
  .cp-body{grid-template-columns:1fr;grid-template-rows:minmax(0,auto) minmax(0,1fr);}
  .cp-paneL{border-right:none;border-bottom:1px solid var(--line);max-height:240px;}
}
@media (prefers-reduced-motion:reduce){
  .cp-root *,.cp-root *::before,.cp-root *::after{transition:none!important;animation:none!important;}
}
`;

    /* ---------- 工具 ---------- */

    function fmtLocal(ts) {
      try { return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false }); } catch { return ""; }
    }
    function num(v) {
      return typeof v === "number" ? v.toLocaleString() : "—";
    }
    function pct(rate) {
      return typeof rate === "number" ? (rate * 100).toFixed(1) + "%" : "—";
    }
    function rateTone(rate) {
      if (typeof rate !== "number") return "";
      if (rate <= 0) return "ok";
      if (rate < 0.05) return "warn";
      return "fail";
    }
    /* per-tool 错误率 = 该工具 错误/调用(calls 缺失/0 → 0) */
    function toolRate(t) {
      const c = typeof t.calls === "number" ? t.calls : 0;
      const er = typeof t.errors === "number" ? t.errors : 0;
      return c > 0 ? er / c : 0;
    }

    /* 按 "provider / model" 切分分组;无分隔符整串当模型名 */
    function groupByProvider(models) {
      const groups = [];
      const map = {};
      for (const m of models) {
        const id = String(m.id || "");
        const i = id.indexOf(" / ");
        const provider = i >= 0 ? id.slice(0, i) : "";
        const name = i >= 0 ? id.slice(i + 3) : id;
        if (!map[provider]) {
          map[provider] = { provider, items: [] };
          groups.push(map[provider]);
        }
        map[provider].items.push({ id, name });
      }
      return groups.map((g) => ({
        provider: g.provider,
        items: g.items.map((it) => Object.assign({}, models.find((m) => String(m.id || "") === it.id), it)),
      }));
    }

    /* 左栏时间范围选项("0"=全部不带参;today/yesterday=单日;7/30/90 → 服务端 ?days= 窗口聚合) */
    const RANGES = [
      { value: "0", label: "全部" },
      { value: "today", label: "今天" },
      { value: "yesterday", label: "昨天" },
      { value: "7", label: "近 7 天" },
      { value: "30", label: "近 30 天" },
      { value: "90", label: "近 90 天" },
    ];

    /* P2.0 对比:行内勾选框上限 + 矩阵默认行数(超出可展开) */
    const CMP_MAX_SELECTED = 4;
    const CMP_MAX_ROWS = 15;

    /* 左栏排序选项(服务端固定按 toolCalls 降序;客户端对 filtered 副本再排) */
    const SORTS = [
      { key: "calls", label: "工具调用" },
      { key: "sessions", label: "会话数" },
      { key: "errors", label: "错误率" },
      { key: "name", label: "模型名" },
    ];

    function sortModels(list, key) {
      const n = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
      const byId = (a, b) => String(a.id).localeCompare(String(b.id));
      const arr = list.slice();
      if (key === "sessions") arr.sort((a, b) => n(b.sessions) - n(a.sessions) || byId(a, b));
      else if (key === "errors") arr.sort((a, b) => n(b.errorRate) - n(a.errorRate) || byId(a, b));
      else if (key === "name") arr.sort((a, b) => byId(a, b));
      else arr.sort((a, b) => n(b.toolCalls) - n(a.toolCalls) || byId(a, b)); // calls(默认,=服务端序)
      return arr;
    }

    /* ---------- 小组件 ---------- */

    function Pill({ tone, label, value }) {
      return e("span", { className: "cp-pill" + (tone ? " cp-pill--" + tone : "") },
        label + " ", e("b", null, value));
    }

    function ModelRow({ m, sel, onSelect, cmp, cmpDisabled, onToggleCmp }) {
      // 勾选框在 button 之外(HTML 规范:button 内不放交互控件),label 包 input
      return e("div", { className: "cp-rowWrap" },
        e("label", { className: "cp-cmpBox", title: cmp ? "取消对比" : "加入对比(最多 " + CMP_MAX_SELECTED + " 个)" },
          e("input", {
            type: "checkbox",
            className: "cp-cmpCheck",
            checked: !!cmp,
            disabled: !!cmpDisabled,
            onChange: () => onToggleCmp(),
            "aria-label": "加入对比 " + m.id,
          })
        ),
        e("button", {
          type: "button",
          className: "cp-row" + (sel ? " cp-row--sel" : ""),
          onClick: () => onSelect(m.id),
          "aria-pressed": sel ? "true" : "false",
          title: m.id,
        },
          e("span", { className: "cp-rowName" }, m.name || m.id),
          e("span", { className: "cp-pill" + (rateTone(m.errorRate) ? " cp-pill--" + rateTone(m.errorRate) : ""), title: "错误率" }, pct(m.errorRate)),
          e("span", { className: "cp-rowN", title: "会话数" }, num(m.sessions))
        )
      );
    }

    function DetailPane({ m, note }) {
      const tools = Array.isArray(m.topTools) ? m.topTools : [];
      const errs = Array.isArray(m.topErrors) ? m.topErrors : [];
      const maxCalls = Math.max(...tools.map((t) => t.calls || 0), 1);
      return e("div", null,
        e("div", { className: "cp-vHead" },
          e("span", { className: "cp-vTitle" }, m.id)
        ),
        e("div", { className: "cp-pills" },
          e(Pill, { label: "会话", value: num(m.sessions) }),
          e(Pill, { label: "工具调用", value: num(m.toolCalls) }),
          e(Pill, { tone: rateTone(m.errorRate), label: "错误率", value: pct(m.errorRate) })
        ),
        note ? e("div", { className: "cp-note" }, note) : null,
        e("div", { className: "cp-secLabel" }, "常用工具 Top"),
        e("div", { className: "cp-table" },
          e("div", { className: "cp-tHead" },
            e("span", { className: "cp-rank" }, "#"),
            e("span", null, "工具"),
            e("span", { className: "cp-c" }, "占比"),
            e("span", { className: "cp-r" }, "调用"),
            e("span", { className: "cp-r" }, "错误"),
            e("span", { className: "cp-r" }, "错误率")
          ),
          tools.length
            ? tools.map((t, i) => e("div", { key: String(t.tool), className: "cp-tRow" },
                e("span", { className: "cp-rank" }, String(i + 1)),
                e("span", { className: "cp-toolName", title: String(t.tool) }, String(t.tool)),
                e("div", { className: "cp-bar" },
                  e("div", { className: "cp-barFill", style: { width: Math.round(((t.calls || 0) / maxCalls) * 100) + "%" } })),
                e("span", { className: "cp-num" }, num(t.calls)),
                e("span", { className: "cp-num" + (t.errors ? " cp-num--err" : " cp-num--zero") }, num(t.errors || 0)),
                e("span", { className: "cp-num" + (t.errors ? " cp-num--" + rateTone(toolRate(t)) : " cp-num--zero"), title: "该工具错误率 = 错误 / 调用" }, pct(toolRate(t)))
              ))
            : e("div", { className: "cp-emptyRow" }, "(无)")
        ),
        e("div", { className: "cp-secLabel" }, "高频错误签名 Top"),
        e("div", { className: "cp-table" },
          e("div", { className: "cp-eHead" },
            e("span", { className: "cp-rank" }, "#"),
            e("span", null, "错误签名"),
            e("span", { className: "cp-r" }, "次数")
          ),
          errs.length
            ? errs.map((t, i) => e("div", { key: i, className: "cp-eRow" },
                e("span", { className: "cp-rank" }, String(i + 1)),
                e("span", { className: "cp-sig", title: String(t.signature) }, String(t.signature)),
                e("span", { className: "cp-num" }, "×" + num(t.count))
              ))
            : e("div", { className: "cp-emptyRow" }, "(无)")
        )
      );
    }

    /* ---------- 多模型对比(P2.0) ---------- */

    /* 极值着色:数值全同→无;否则最高/最低按语义着色(worstIsMax=true 表示高=坏) */
    function extremeTone(values, v, worstIsMax) {
      const min = Math.min.apply(null, values);
      const max = Math.max.apply(null, values);
      if (min === max) return "";
      if (worstIsMax) return v === max ? "worst" : v === min ? "best" : "";
      return v === max ? "best" : v === min ? "worst" : "";
    }

    /* 最高值加粗(中性强调,无好坏语义) */
    function maxTone(values, v) {
      const max = Math.max.apply(null, values);
      const min = Math.min.apply(null, values);
      return min === max ? "" : (v === max ? "top" : "");
    }

    /* P2.0 列色码:同族模型(同名不同端口)靠颜色区分列;4 色可辨,循环取用 */
    const CMP_COLORS = ["#0969da", "#1a7f37", "#9a6700", "#8250df"];
    const cmpColor = (i) => CMP_COLORS[i % CMP_COLORS.length];

    function ComparePane({ models, note, expanded, onToggleExpanded, onBack, onOpenModel }) {
      const n = models.length;
      const gridStyle = { gridTemplateColumns: "132px repeat(" + n + ", minmax(0, 1fr))" };
      const shortName = (m) => {
        const id = String(m.id || "");
        const i = id.indexOf(" / ");
        return i >= 0 ? id.slice(i + 3) : id;
      };
      const providerOf = (m) => {
        const id = String(m.id || "");
        const i = id.indexOf(" / ");
        return i >= 0 ? id.slice(0, i) : "(未知)";
      };
      /* 列头两行:provider 行(列色)+ 模型名行;点列头直达该模型单模型画像。
         同族模型(Ornith-…-A3B vs Ornith-…-A3B-FP8)短名几乎相同,provider(端口)是区分键。 */
      const colHead = (corner, key) => e("div", { key, className: "cp-cmpGrid cp-cmpHead", style: gridStyle },
        e("span", { className: "cp-cmpLabel" }, corner),
        models.map((m, i) => e("span", {
          key: m.id,
          className: "cp-cmpCol",
          style: { borderTopColor: cmpColor(i) },
          onClick: () => onOpenModel(m.id),
          title: "查看单模型画像:" + m.id,
        },
          e("span", { className: "cp-cmpColProv", style: { color: cmpColor(i) }, title: m.id }, providerOf(m)),
          e("span", { className: "cp-cmpColName" }, shortName(m))
        ))
      );
      const tableCls = "cp-table cp-cmpTbl";

      // ① 核心指标:会话/调用/错误数/错误率
      const rates = models.map((m) => (typeof m.errorRate === "number" ? m.errorRate : 0));
      const calls = models.map((m) => (typeof m.toolCalls === "number" ? m.toolCalls : 0));
      const sessions = models.map((m) => (typeof m.sessions === "number" ? m.sessions : 0));
      const errs = models.map((m) => (typeof m.toolErrors === "number" ? m.toolErrors : 0));
      const metricRow = (key, label, values, fmt, toneOf) => e("div", { key, className: "cp-cmpGrid cp-cmpRow" },
        e("span", { className: "cp-cmpLabel" }, label),
        models.map((m, i) => e("span", { key: m.id, className: "cp-num" + (toneOf(values, i) ? " cp-num--" + toneOf(values, i) : "") }, fmt(values[i])))
      );

      // ② 工具矩阵:并集行(tools 缺失回落 topTools),按行内最大调用降序,默认 15 行
      const byTool = new Map();
      for (const m of models) {
        const list = Array.isArray(m.tools) && m.tools.length > 0
          ? m.tools
          : (Array.isArray(m.topTools) ? m.topTools : []);
        for (const t of list) {
          const k = String(t.tool);
          if (!byTool.has(k)) byTool.set(k, {});
          byTool.get(k)[m.id] = { calls: typeof t.calls === "number" ? t.calls : 0, errors: typeof t.errors === "number" ? t.errors : 0 };
        }
      }
      const toolRows = [...byTool.entries()].map(([tool, cells]) => ({
        tool,
        cells,
        maxCalls: Math.max(0, ...Object.values(cells).map((c) => c.calls)),
      })).sort((a, b) => b.maxCalls - a.maxCalls || a.tool.localeCompare(b.tool));
      const toolRowsVis = expanded ? toolRows : toolRows.slice(0, CMP_MAX_ROWS);

      // ③ 高频错误签名:并集行,按合计次数降序,Top-10
      const bySig = new Map();
      for (const m of models) {
        for (const t of Array.isArray(m.topErrors) ? m.topErrors : []) {
          const k = String(t.signature);
          if (!bySig.has(k)) bySig.set(k, {});
          bySig.get(k)[m.id] = typeof t.count === "number" ? t.count : 0;
        }
      }
      const sigRows = [...bySig.entries()].map(([sig, cells]) => ({
        sig,
        cells,
        total: Object.values(cells).reduce((s, v) => s + v, 0),
      })).sort((a, b) => b.total - a.total || a.sig.localeCompare(b.sig)).slice(0, 10);

      // ④ 每日趋势:并集日(升序);条宽 = 当日调用 / 全局最大日调用
      const daySet = new Set();
      for (const m of models) for (const s of Array.isArray(m.series) ? m.series : []) daySet.add(s.d);
      const days = [...daySet].sort();
      const maxDayCalls = Math.max(
        0,
        ...models.flatMap((m) => (Array.isArray(m.series) ? m.series : []).map((s) => (typeof s.calls === "number" ? s.calls : 0)))
      );

      return e("div", null,
        e("div", { className: "cp-vHead" },
          e("span", { className: "cp-vTitle" }, "模型对比 · " + n + " 个模型"),
          e("span", { className: "cp-spacer" }),
          e("button", { type: "button", className: "cp-btn", onClick: onBack }, "← 单模型画像")
        ),
        note ? e("div", { className: "cp-note" }, note) : null,

        e("div", { className: "cp-secLabel" }, "核心指标"),
        e("div", { className: tableCls },
          colHead("指标", "cmp-metric-head"),
          metricRow("cmp-sess", "会话数", sessions, (v) => num(v), (vals, i) => maxTone(vals, vals[i])),
          metricRow("cmp-calls", "工具调用", calls, (v) => num(v), (vals, i) => maxTone(vals, vals[i])),
          metricRow("cmp-errs", "错误数", errs, (v) => num(v), (vals, i) => extremeTone(vals, vals[i], true)),
          metricRow("cmp-rate", "错误率", rates, (v) => pct(v), (vals, i) => extremeTone(vals, vals[i], true))
        ),

        e("div", { className: "cp-secLabel" }, "工具使用矩阵 · " + toolRows.length + " 个工具"),
        e("div", { className: tableCls },
          colHead("工具", "cmp-tool-head"),
          toolRowsVis.length
            ? toolRowsVis.map((r) => e("div", { key: r.tool, className: "cp-cmpGrid cp-cmpRow" },
                e("span", { className: "cp-cmpTool cp-mTool", title: r.tool }, r.tool),
                models.map((m) => {
                  const c = r.cells[m.id];
                  return c
                    ? e("span", { key: m.id, className: "cp-num" + (c.errors > 0 ? " cp-num--" + rateTone(toolRate(c)) : " cp-num--zero"), title: "调用 " + num(c.calls) + " · 错误 " + num(c.errors) },
                        num(c.calls) + " · " + pct(toolRate(c)))
                    : e("span", { key: m.id, className: "cp-num cp-num--zero", title: "该模型未使用(或不在 Top-10)" }, "—");
                })
              ))
            : e("div", { className: "cp-emptyRow" }, "(无工具数据)"),
          toolRows.length > CMP_MAX_ROWS
            ? e("div", { className: "cp-emptyRow" },
                e("button", { type: "button", className: "cp-btn cp-btnMini", onClick: onToggleExpanded },
                  expanded ? "收起" : "展开全部 " + toolRows.length + " 个工具"))
            : null
        ),

        e("div", { className: "cp-secLabel" }, "高频错误签名"),
        e("div", { className: tableCls },
          colHead("错误签名", "cmp-sig-head"),
          sigRows.length
            ? sigRows.map((r) => e("div", { key: r.sig, className: "cp-cmpGrid cp-cmpRow" },
                e("span", { className: "cp-cmpSig", title: r.sig }, r.sig),
                models.map((m) => {
                  const c = r.cells[m.id];
                  return c > 0
                    ? e("span", { key: m.id, className: "cp-num" }, "×" + num(c))
                    : e("span", { key: m.id, className: "cp-num cp-num--zero" }, "—");
                })
              ))
            : e("div", { className: "cp-emptyRow" }, "(无)")
        ),

        days.length
          ? [
              e("div", { key: "cmp-trend-label", className: "cp-secLabel" }, "每日趋势 · " + days.length + " 天"),
              e("div", { key: "cmp-trend", className: tableCls },
                colHead("日期", "cmp-trend-head"),
                days.map((d) => e("div", { key: d, className: "cp-cmpGrid cp-cmpRow" },
                  e("span", { className: "cp-cmpDay", title: d }, d.slice(5)),
                  models.map((m, i) => {
                    const s = (Array.isArray(m.series) ? m.series : []).find((x) => x.d === d);
                    if (!s) return e("span", { key: m.id, className: "cp-num cp-num--zero", title: d + " 无活动" }, "—");
                    const w = maxDayCalls > 0 ? Math.round(((typeof s.calls === "number" ? s.calls : 0) / maxDayCalls) * 100) : 0;
                    const er = typeof s.errors === "number" ? s.errors : 0;
                    return e("div", { key: m.id, className: "cp-tCell", title: d + " · 调用 " + num(s.calls) + " · 错误 " + num(er) },
                      e("div", { className: "cp-tBar" }, e("div", { className: "cp-tBarFill", style: { width: w + "%", background: cmpColor(i) } })),
                      e("span", { className: "cp-tNum" }, num(s.calls)),
                      er > 0 ? e("span", { className: "cp-tErr" }, "×" + num(er)) : null
                    );
                  })
                ))
              )
            ]
          : null
      );
    }

    function EmptyState({ title, hint }) {
      return e("div", { className: "cp-empty" },
        e("div", { className: "cp-emptyTitle" }, title),
        hint ? e("div", { className: "cp-emptyHint" }, hint) : null);
    }

    /* ---------- 面板组件 ---------- */

    function CapProfilePanel() {
      // useState 声明顺序是契约测试的注入索引,勿随意增删移动
      // 初始值读模块级缓存:重挂载(切 tab 回来)首屏直渲旧数据,不闪 loading
      const [doc, setDoc] = React.useState(cachedDoc);
      const [error, setError] = React.useState("");
      const [loading, setLoading] = React.useState(cachedDoc ? false : true);
      const [pulse, setPulse] = React.useState(0);
      const [updatedAt, setUpdatedAt] = React.useState(cachedAt);
      const [selectedId, setSelectedId] = React.useState(null);
      const [query, setQuery] = React.useState("");
      const [sortKey, setSortKey] = React.useState(cachedSortKey); // 索引 7,追加在既有 0-6 之后,不破坏注入契约
      const [rangeDays, setRangeDays] = React.useState(cachedRangeDays); // 索引 8("0"=全部 / "today" / "yesterday" / "7"/"30"/"90")
      // P2.0 对比:新状态一律追加在既有契约索引 0-8 之后;勾选/视图模块级持久(切 tab 保持)
      const [compareIds, setCompareIds] = React.useState(cachedCompareIds); // 索引 9(string[],最多 4)
      const [viewMode, setViewMode] = React.useState(cachedViewMode); // 索引 10("detail" | "compare")
      const [matrixExpanded, setMatrixExpanded] = React.useState(false); // 索引 11(矩阵展开,不持久)

      const switchView = (mode) => { cachedViewMode = mode; setViewMode(mode); };
      const toggleCompare = (id) => {
        const next = compareIds.includes(id)
          ? compareIds.filter((x) => x !== id)
          : (compareIds.length >= CMP_MAX_SELECTED ? compareIds : compareIds.concat(id));
        cachedCompareIds = next;
        setCompareIds(next);
      };

      const load = React.useCallback(async () => {
        setLoading(true);
        try {
          // P1.5: 时间范围 → ?days=("0"=全量不带参;today/yesterday/7/30/90;mock 半服务端忽略 days)
          const res = await fetch(PROFILE_PATH + (rangeDays !== "0" ? "?days=" + rangeDays : ""), { headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE } });
          if (res.status === 404) throw new Error("404:宿主路由未注册(node 半可能未加载或 dsh 未重启)");
          if (!res.ok) throw new Error("HTTP " + res.status);
          const s = await res.json();
          if (!s || !Array.isArray(s.models)) throw new Error("响应结构不符(缺 models 数组)");
          cachedDoc = s;
          cachedAt = Date.now();
          setDoc(s);
          setError("");
          setUpdatedAt(cachedAt);
        } catch (err) {
          setError("数据加载失败: " + (err instanceof Error ? err.message : String(err)));
        }
        setLoading(false);
        setPulse((p) => p + 1);
      }, [rangeDays]); // 切换时间范围 → load 新身份 → effect 重跑(立即重取 + 重建定时器)

      React.useEffect(() => {
        load();
        const iv = setInterval(load, REFRESH_MS);
        return () => clearInterval(iv);
      }, [load]);

      const models = doc && Array.isArray(doc.models) ? doc.models : [];
      const q = query.trim().toLowerCase();
      const filtered = q
        ? models.filter((m) => String(m.id || "").toLowerCase().includes(q))
        : models;
      const selected = filtered.find((m) => m.id === selectedId) || filtered[0] || null;
      const groups = groupByProvider(sortModels(filtered, sortKey));

      /* P2.0 对比:勾选集(按勾选序)对当前文档过滤 → 有效对比对象;
         有效 ≥2 才渲染对比视图,否则回落到单模型详情(勾选集本身不清空) */
      const validCompare = compareIds
        .map((id) => models.find((m) => m.id === id))
        .filter(Boolean);
      const showCompare = viewMode === "compare" && validCompare.length >= 2 && !loading;

      const meta = "回顾式分析 · " + REFRESH_MS / 1000 + "s 自动刷新" +
        (updatedAt && !loading ? " · 更新 " + fmtLocal(updatedAt) : "") +
        (rangeDays !== "0" && doc && doc.window && doc.window.from && doc.window.to
          ? " · 窗口 " + (doc.window.from === doc.window.to ? doc.window.from : doc.window.from + " ~ " + doc.window.to) : "");

      const rightContent =
        loading && !doc
          ? e("div", { className: "cp-loading" }, "正在读取会话档案…")
          : models.length === 0
            ? e(EmptyState, {
                title: rangeDays !== "0" ? "本时间段暂无模型" : "暂无会话档案",
                hint: rangeDays !== "0"
                  ? "该时间范围内没有模型活动,试试更大的时间窗口。"
                  : "模型积累会话后,这里开始生成能力画像:会话量、常用工具、高频错误与错误率。",
              })
            : showCompare
              ? e(ComparePane, {
                  models: validCompare,
                  note: doc && doc.note,
                  expanded: matrixExpanded,
                  onToggleExpanded: setMatrixExpanded,
                  onBack: () => switchView("detail"),
                  onOpenModel: (id) => { switchView("detail"); setSelectedId(id); },
                })
              : selected
                ? e(DetailPane, { m: selected, note: doc && doc.note })
                : e("div", { className: "cp-empty" }, e("div", { className: "cp-emptyHint" }, "从左侧选择一个模型查看画像。"));

      return e("div", { className: "cp-root" },
        e("style", null, CSS),
        e("div", { className: "cp-head" },
          e("div", { className: "cp-headRow" },
            e("span", { className: "cp-title" }, "模型能力画像"),
            doc && doc.source === "mock" ? e("span", { className: "cp-pill cp-pill--warn" }, "示例数据") : null,
            e("span", { className: "cp-spacer" }),
            e("button", {
              type: "button",
              className: "cp-btn",
              disabled: loading,
              onClick: load,
              title: "立即刷新(每 " + REFRESH_MS / 1000 + "s 自动刷新一次)",
            }, loading ? "同步中…" : "刷新")
          ),
          e("div", { className: "cp-meta" }, meta)
        ),
        e("div", { className: "cp-body" },
          e("div", { className: "cp-paneL" },
            e("input", {
              className: "cp-search",
              type: "search",
              placeholder: "搜索模型…",
              value: query,
              onChange: (ev) => setQuery(ev.target.value),
              "aria-label": "搜索模型",
            }),
            models.length
              ? e("div", null,
                  e("div", { className: "cp-filters" },
                    e("select", {
                      className: "cp-sort",
                      value: rangeDays,
                      disabled: !!(doc && doc.source === "mock"),
                      title: doc && doc.source === "mock" ? "示例数据不支持时间筛选" : "时间范围",
                      onChange: (ev) => {
                        const v = ev.target.value; // 原始字符串("0"/today/yesterday/"7"/"30"/"90")
                        cachedRangeDays = v;
                        setRangeDays(v);
                      },
                      "aria-label": "时间范围",
                    }, RANGES.map((r) => e("option", { key: r.value, value: r.value }, r.label))),
                    e("select", {
                      className: "cp-sort",
                      value: sortKey,
                      onChange: (ev) => { cachedSortKey = ev.target.value; setSortKey(ev.target.value); },
                      "aria-label": "排序模型",
                      title: "排序模型",
                    }, SORTS.map((s) => e("option", { key: s.key, value: s.key }, s.label)))
                  ),
                  e("div", { className: "cp-kickerRow" },
                    e("span", { className: "cp-kicker" }, "模型 " + filtered.length + " / " + models.length),
                    validCompare.length >= 2
                      ? e("button", {
                          type: "button",
                          className: "cp-btn cp-btnCmp",
                          onClick: () => switchView("compare"),
                        }, "对比 (" + validCompare.length + ")")
                      : null
                  ),
                  filtered.length
                    ? groups.map((g) => e("div", { key: g.provider || "unknown", className: "cp-mGroup" },
                        e("div", { className: "cp-mHead" },
                          e("span", { className: "cp-mHeadCode", title: g.provider || "(未知 provider)" }, g.provider || "(未知)")),
                        g.items.map((m) => e(ModelRow, {
                          key: m.id,
                          m,
                          sel: !!(selected && m.id === selected.id),
                          // 对比视图下点行 = 退出对比并选中该模型
                          onSelect: (id) => { if (viewMode === "compare") switchView("detail"); setSelectedId(id); },
                          cmp: compareIds.includes(m.id),
                          cmpDisabled: !compareIds.includes(m.id) && compareIds.length >= CMP_MAX_SELECTED,
                          onToggleCmp: () => toggleCompare(m.id),
                        }))
                      ))
                    : e("div", { className: "cp-emptyL" }, "无匹配的模型")
                )
              : e("div", { className: "cp-emptyL" }, loading ? "加载中…" : (rangeDays !== "0" ? "本时间段暂无模型" : "暂无模型"))
          ),
          e("div", { className: "cp-paneR" },
            e("div", { className: "cp-fade", key: pulse },
              error ? e("div", { className: "cp-flash", role: "alert" }, error) : null,
              rightContent
            )
          )
        )
      );
    }

    /* ---------- 插件主体 ---------- */

    const inject = ["slots"];

    function apply(ctx) {
      ctx.slots.inject("conversation.view", () => ctx.slots.register({
        name: "conversation.view",
        id: "capability-profile",
        order: 40,
        label: "能力画像",
      }, CapProfilePanel));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
