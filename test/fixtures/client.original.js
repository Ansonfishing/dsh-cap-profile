/**
 * dsh-cap-profile — 模型能力画像(browser 半)
 *
 * 会话区 conversation.view tab「能力画像」:只读观察窗。数据经宿主同源路由
 * GET /capability-profile 拉取(宿主侧直接读 ~/.dsh/sessions,无 live agent
 * 依赖,冷会话可用)—— dsh-web-review 同源路由模式。
 *
 * 手写 CJS factory,经 window.__ModuleLoader__.load 注册。
 * ★ banner id 必须等于 cordis 行的 entry name:
 *   - dev 通道(当前): "@dsh-cap-profile-dev/plugin"(cordis.yml + --patch)
 *   - 正式通道:        "dsh-cap-profile"(cordis.patch.yml 装入 profile)
 * 切换通道时同步改本文件 banner id。
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

    /* ---------- 样式 ---------- */

    const S = {
      root: {
        display: "flex", flexDirection: "column", height: "100%", minHeight: 0,
        padding: "14px 16px", gap: 12, boxSizing: "border-box", fontSize: 13,
        color: "var(--dsw-alias-label-primary, #e5e5e5)", overflowY: "auto",
      },
      header: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
      title: { fontSize: 14, fontWeight: 600 },
      meta: { color: "var(--dsw-alias-label-tertiary, #888)", fontSize: 12 },
      refresh: {
        marginLeft: "auto", background: "none",
        border: "1px solid var(--dsw-alias-border-l2, #444)", borderRadius: 999,
        color: "var(--dsw-alias-label-secondary, #aaa)",
        padding: "3px 12px", cursor: "pointer", fontSize: 12,
      },
      note: {
        fontSize: 12, color: "var(--dsw-alias-label-secondary, #aaa)",
        border: "1px dashed var(--dsw-alias-border-l2, #444)",
        borderRadius: 8, padding: "6px 10px",
      },
      err: {
        fontSize: 12, color: "#f87171",
        border: "1px solid rgba(248,113,113,.4)", borderRadius: 8, padding: "6px 10px",
      },
      card: {
        border: "1px solid var(--dsw-alias-border-l2, #333)", borderRadius: 10,
        padding: "10px 12px", display: "flex", flexDirection: "column", gap: 10,
      },
      cardHead: { display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" },
      modelId: { fontSize: 13, fontWeight: 600, wordBreak: "break-all" },
      kv: { color: "var(--dsw-alias-label-secondary, #aaa)", fontSize: 12 },
      section: { display: "flex", flexDirection: "column", gap: 5 },
      sectionLabel: {
        fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)",
        textTransform: "uppercase", letterSpacing: ".05em",
      },
      row: { display: "flex", alignItems: "center", gap: 8, fontSize: 12 },
      rowKey: { width: 180, flexShrink: 0, color: "var(--dsw-alias-label-secondary, #bbb)", wordBreak: "break-all" },
      barTrack: {
        flex: 1, height: 4, borderRadius: 2, overflow: "hidden", minWidth: 60,
        background: "var(--dsw-alias-border-l2, #333)",
      },
      num: { width: 56, flexShrink: 0, textAlign: "right", color: "var(--dsw-alias-label-primary, #ddd)" },
      errRow: { display: "flex", alignItems: "baseline", gap: 8, fontSize: 12 },
      errSig: { wordBreak: "break-all", color: "var(--dsw-alias-label-secondary, #bbb)" },
      count: { width: 36, flexShrink: 0, textAlign: "right", color: "var(--dsw-alias-label-tertiary, #888)" },
      empty: { color: "var(--dsw-alias-label-tertiary, #777)", fontSize: 12 },
      loading: { color: "var(--dsw-alias-label-tertiary, #888)", fontSize: 12, padding: "24px 0", textAlign: "center" },
    };

    function barFill(pct) {
      return { height: "100%", borderRadius: 2, background: "var(--dsw-alias-accent-l2, #6aa2ff)", width: pct + "%" };
    }

    /* ---------- 渲染 helper ---------- */

    function toolRows(tools) {
      if (!Array.isArray(tools) || !tools.length) return e("div", { style: S.empty }, "(无)");
      const max = Math.max(...tools.map((t) => t.calls || 0), 1);
      return e("div", null, tools.map((t) => e("div", { key: t.tool, style: S.row },
        e("span", { style: S.rowKey }, t.tool),
        e("div", { style: S.barTrack }, e("div", { style: barFill(((t.calls || 0) / max) * 100) })),
        e("span", { style: S.num }, (t.calls || 0) + (t.errors ? ` (错${t.errors})` : ""))
      )));
    }

    function errorRows(errs) {
      if (!Array.isArray(errs) || !errs.length) return e("div", { style: S.empty }, "(无)");
      return e("div", null, errs.map((t) => e("div", { key: t.signature, style: S.errRow },
        e("span", { style: S.errSig }, t.signature),
        e("span", { style: S.count }, "×" + (t.count || 0))
      )));
    }

    function modelCard(m) {
      const rate = typeof m.errorRate === "number" ? (m.errorRate * 100).toFixed(1) + "%" : "—";
      return e("div", { key: m.id, style: S.card },
        e("div", { style: S.cardHead },
          e("span", { style: S.modelId }, m.id),
          e("span", { style: S.kv },
            `会话 ${m.sessions} · 工具调用 ${m.toolCalls} · 错误率 ${rate}`
          )
        ),
        e("div", { style: S.section },
          e("div", { style: S.sectionLabel }, "常用工具 Top"),
          toolRows(m.topTools)
        ),
        e("div", { style: S.section },
          e("div", { style: S.sectionLabel }, "高频错误签名 Top"),
          errorRows(m.topErrors)
        )
      );
    }

    /* ---------- 面板组件 ---------- */

    function CapProfilePanel() {
      const [doc, setDoc] = React.useState(null);
      const [error, setError] = React.useState("");
      const [loading, setLoading] = React.useState(true);

      const load = React.useCallback(async () => {
        setLoading(true);
        try {
          const res = await fetch(PROFILE_PATH, { headers: { [CLIENT_HEADER]: CLIENT_HEADER_VALUE } });
          if (res.status === 404) throw new Error("404:宿主路由未注册(node 半可能未加载或 dsh 未重启)");
          if (!res.ok) throw new Error("HTTP " + res.status);
          const s = await res.json();
          if (!s || !Array.isArray(s.models)) throw new Error("响应结构不符(缺 models 数组)");
          setDoc(s);
          setError("");
        } catch (err) {
          setError("数据加载失败: " + (err instanceof Error ? err.message : String(err)));
        }
        setLoading(false);
      }, []);

      React.useEffect(() => {
        load();
        const iv = setInterval(load, REFRESH_MS);
        return () => clearInterval(iv);
      }, [load]);

      const models = doc && Array.isArray(doc.models) ? doc.models : [];
      return e("div", { style: S.root },
        e("div", { style: S.header },
          e("span", { style: S.title }, "模型能力画像"),
          e("span", { style: S.meta },
            "回顾式分析 · " + REFRESH_MS / 1000 + "s 自动刷新" +
            (doc && doc.source === "mock" ? " · 示例数据" : "")
          ),
          e("button", { type: "button", style: S.refresh, onClick: load }, "刷新")
        ),
        loading && e("div", { style: S.loading }, "正在读取会话档案…"),
        !loading && error && e("div", { style: S.err }, error),
        !loading && doc && e("div", { style: S.note }, doc.note || ""),
        !loading && models.map(modelCard)
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
