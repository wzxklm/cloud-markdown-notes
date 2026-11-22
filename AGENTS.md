# Notes 项目约束

遵循上级 [VPS 规范](../AGENTS.md)。本文件只补充 Notes 特有约束，部署路径和命令以 [README](README.md) 为准。

## 数据与环境

- 生产使用 `notes-prod`、`.env.prod`、`docker/compose.prod.yml`，项目目录必须为 `/root/notes/docker`；生产持久化在 `docker/runtime/prod/`。改变 `--project-directory` 前核对实际挂载，禁止误接空数据库。
- 开发为 `notes-dev`、测试为 `notes-test`，均不得连接生产 PostgreSQL 或 workspace。启动开发时按 README 覆盖默认端口为 localhost 的独立端口。
- `tests/full-test-runner.ts` 会清理数据库和 workspace；只能在隔离测试容器中执行。不要在生产执行 `npm test`、测试 runner 或测试数据库清理。
- 生产使用已固定的本地迁移镜像；不通过拉取 latest 或修改 NOTES_IMAGE 隐式升级。

## 开发与验证

- 逻辑保持简单，只实现明确需求；不添加假设性的抽象和兜底。
- 主机执行 `sh tests/run-e2e.sh` 编排测试容器；实际测试运行在容器内。`npm test` 是该编排脚本的别名，不是普通开发容器内的入口。
- 完整测试顺序：计费状态回归、API、CLI、MCP、Web。对应入口在 `tests/full-test-runner.ts`；测试报告位于 `runtime/fulltest-docker/`。
- 新增或改变用户可见行为时，同步 [功能清单](docs/可测试功能.md) 与相关测试，覆盖成功、认证/权限和关键失败路径。不要将清单本身当成自动化覆盖或通过的证据。
- CLI 变化同步 `packages/cli/README.md`、`docs/skills/cloud-notes-cli/SKILL.md`；仅当已安装对应本地 skill 时同步其副本，不为文档整理自动安装。
- 公开接口和部署步骤变化同步 README；源码树无需在多份文档重复列出。
- 只有涉及真实 UI 体验或自动化无法覆盖的问题才使用浏览器手测，优先访问开发端口，不能操作用户生产笔记来替代测试。

## 提交与发布

- 只有用户要求时才提交代码或发布包/镜像。提交前检查 diff，排除凭据、数据、备份及无关修改。
- commit message 用标题加正文，写明最终变更、原因、验证结果及未完成项；重要数据或部署风险需说明。
- 纯文档改动核对命令、路径、接口与链接即可；不为措辞整理运行会重置数据的业务测试。
