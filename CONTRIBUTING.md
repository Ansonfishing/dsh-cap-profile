# 贡献指南

感谢关注！欢迎 PR。

## PR 要求

- **测试必须全绿**：`npm test`（node --test，零运行时依赖，Node ≥ 20）。
- **小步 PR**：一个 PR 只解决一件事，附简要说明动机。
- **不提交个人路径与配置**：本机 `~/.dsh` 路径、会话数据、个人笔记一律不入库；`DESIGN.md` / `PROGRESS.md`（个人过程文档）已在 `.gitignore` 中排除。
- **不提交真实环境信息**：API key、token、私有模型名、个人文档引用一律脱敏；测试夹具用 `Demo-*` 等虚构名。
- **commit 规范**：`type(scope): 简述`，type ∈ feat / fix / docs / test / chore。
- 客户端渲染改动可先用 `test/harness/index.html`（浏览器直接打开，mock 数据）验证，再跑测试。

## 本地开发

```bash
npm test                                  # 全部单测
dsh web --patch ./cordis.patch.yml --port 3090   # 开发预览
```

## 许可证

MIT（见 [LICENSE](LICENSE)）。
