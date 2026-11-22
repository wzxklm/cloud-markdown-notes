# Cloud Markdown Notes

Cloud Markdown Notes 是可自托管的多用户 Markdown 笔记服务。你可以在浏览器里写作，在终端批量整理笔记，也可以让 AI 通过 MCP 搜索和编辑同一个工作区。

[打开 Notes](https://notes.bosschat.de) · [自托管部署指南](docs/self-hosting.md) · [MIT 许可证](LICENSE)

## 笔记与版本

- **整理与检索**：每个账号拥有独立工作区，支持多级目录、Markdown 预览、路径匹配、全文搜索和按行读取。
- **版本与分享**：随时保存草稿，查看差异并提交版本。可以恢复指定文件或目录，也可以把某篇已提交且自身无未提交改动的笔记公开为固定版本链接。其他笔记可以继续保留草稿。
- **导入与导出**：导入 ZIP 前可预览文件及冲突。导出包含 Markdown 笔记和目录，包括空目录。

## 选择访问方式

| 入口 | 从哪里开始 |
| --- | --- |
| Web | 在 [Notes 官网](https://notes.bosschat.de) 注册或登录。新账号由管理员激活，也可在启用计费的实例上订阅。 |
| CLI | 安装 Node.js 18 或更新版本，按 [CLI 使用说明](packages/cli/README.md) 设置实例地址并登录。仓库提供可交给 AI 使用的 [CLI skill](docs/skills/cloud-notes-cli/SKILL.md)。 |
| MCP | 在工作区创建个人 MCP 密钥，通过 Streamable HTTP 连接实例的 `/mcp` 端点。详见 [MCP 连接指南](docs/connect-notes-mcp.md)。 |
| HTTP API | 使用会话 Bearer token 访问 `/api` 下的笔记、搜索、版本和分享接口。编辑时传入读到的文件版本以检测冲突。详见 [接口与功能清单](docs/可测试功能.md)。 |

## 自托管与计费

自托管有两种方式，共用 Docker Compose 配置与数据目录：

- [从公开镜像部署](docs/self-hosting.md#从公开镜像部署)：拉取 Docker Hub 发行镜像和对应的配置文件，适合直接运行。
- [从源码部署](docs/self-hosting.md#从源码部署)：克隆仓库，在 Docker 中构建指定提交或自己的修改，再启动同一套服务。

Stripe 计费可选。启用后，用户可以按 **HK$10/月**订阅，也可以一次性充值 **HK$10–1,000** 的整数金额。充值进入钱包，只有用户主动开启余额续费才会按月扣款。两种付款方式的配置和沙箱验收步骤见[支付配置指南](docs/self-hosting.md#stripe-沙箱配置)。

## 开发与测试

从仓库根目录在 Bash 中启动开发环境：

```bash
export HOST_API_PORT=127.0.0.1:18082 HOST_WEB_PORT=127.0.0.1:15173
export HOST_DATA_ROOT=./runtime/dev
dev=(docker compose --env-file .env.dev --project-directory "$PWD" -f docker/compose.yml -p notes-dev)
"${dev[@]}" up -d --build --wait app db
"${dev[@]}" exec app npm run lint
"${dev[@]}" exec app npm run build
```

结束开发时，在同一终端运行 `"${dev[@]}" down`。容器内源码路径为 `/app`。开发服务运行期间可访问 [本地 Web 页面](http://127.0.0.1:15173) 和 [API 健康检查](http://127.0.0.1:18082/api/health)。

在主机运行 `sh tests/run-e2e.sh` 可启动独立的 `notes-test` 环境，执行计费、API、CLI、MCP 和浏览器测试。测试会重置测试库与工作区，使用专用测试数据；报告保存在 `runtime/fulltest-docker/`。

维护官方托管实例时，请参阅[生产运维手册](docs/production-operations.md)。
