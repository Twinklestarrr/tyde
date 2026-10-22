# pi-web 来源与适配记录

- 公共仓库：[agegr/pi-web](https://github.com/agegr/pi-web)。
- 固定提交：`7c0778a8bc7342f1ededc6f5fb190dc6f4e43044`（package version `0.12.2`）。
- 许可证：MIT，作者 `agegr`，原文保留在 [LICENSE](LICENSE)。
- 引入方式：选择前端源码子集并适配，不在应用目录嵌套 Git 仓库，不依赖上游可执行包。

## 完整上游参考仓库

本机完整克隆保留在仓库根目录下的 `.local/upstream/pi-web/`（含独立 `.git`），固定在上述提交，供后续开发查阅和对照。该目录已由根 `.gitignore` 的 `.local/` 规则忽略，不参与 workspace、构建或提交；它与 `apps/agent-web` 中已适配的前端代码分开维护。本目录 `upstream/pi-web/` 只保存许可证和来源说明，不是完整源码。

完整上游的 `app/` 包含 Next 页面及 API，`components/`、`hooks/`、`lib/` 包含界面、状态和执行相关代码；先阅读其 `README.md` 了解入口。查阅不等于引入：W2 执行统一在 `apps/agent` 实现，不能直接启用上游本机执行、JSONL、终端或凭据存储。

原临时克隆位于 `/private/tmp/tyde-pi-web-w1-upstream`；临时目录不作为后续开发的固定入口。其他机器若没有完整参考仓库，可在 tyde 根目录重建：

```sh
mkdir -p .local/upstream
git clone https://github.com/agegr/pi-web.git .local/upstream/pi-web
git -C .local/upstream/pi-web checkout --detach 7c0778a8bc7342f1ededc6f5fb190dc6f4e43044
```

## 引入范围

| 上游文件                            | 本地文件与适配                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `components/MarkdownBody.tsx`       | `src/components/MarkdownBody.tsx`，保留 memo 分块展示、列表编号宽度、表格滚动；改为直接使用 react-markdown／remark-gfm，移除文件、图片、音视频、Mermaid、数学及应用路由能力。原始 HTML 不执行，图片仅显示标签，链接仅允许 HTTP(S)。               |
| `lib/markdown-blocks.ts`            | `src/lib/markdown-blocks.ts`，保留流式 Markdown 分块算法，补齐严格索引检查与来源注释。                                                                                                                                                            |
| `lib/markdown-list-continuation.ts` | `src/lib/markdown-list-continuation.ts`，保留列表／任务清单／中文序号续行及代码围栏保护，补齐严格索引检查与来源注释。                                                                                                                             |
| `components/ChatInput.tsx`          | `src/components/ChatInput.tsx`，提取 textarea 自动高度、beforeinput 列表续行和输入法确认保护，改为纯文本受控草稿；移除附件、命令、历史、模型选择、会话与请求逻辑。W3 增加发送回调、真实可用状态及 ⌘／Ctrl + Enter；请求逻辑集中在自身服务客户端。 |
| `app/globals.css`                   | `src/styles/pi-web.css`，提取 light／dark／Mist 主题变量与纯文本 Markdown、表格样式；移除 Next、xterm、文件面板及其余样式。页面布局在 `src/styles/global.css` 独立维护。                                                                          |

未复制上游 Next API、Pi 执行器、JSONL／本地会话恢复、文件系统、项目／终端、登录／凭据、本地存储、服务工作线程、通知推送、演示工程或截图。上游整体包含服务端代码，不能当成仅前端项目直接运行。后续真实执行集中在 `apps/agent`，通过共享契约连接本界面。

W3 的页面、会话控制器、产品投影与 Agent HTTP／SSE 客户端为本仓库新增实现，继续使用已适配的 Markdown 与输入基础代码，没有继续复制上游源码。页面只展示服务端真实产品记录，没有预置模型回答；只有明确点击发送或发送快捷键提交命令，刷新和订阅不会启动任务。

## 来源摘要

以下 SHA-256 针对固定提交的完整原文件，供复核适配来源；不是适配后文件摘要。

| 原文件                              | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `LICENSE`                           | `19cee3b1b8fd9b42f9515366bc1a7dfaaf22fcb006234ebb85ff2f6f8c52eb2b` |
| `components/ChatInput.tsx`          | `a2a6d3fa381e6052a4327f6384ed975c4974c0e6f8f0aad60ada75cdbfc62161` |
| `components/MarkdownBody.tsx`       | `d2e0dcdc5a776f31430b16307ed560f5fd93c057e826a037df5fdf77e351dac6` |
| `lib/markdown-blocks.ts`            | `59123be8d741ae47d0f881833a99ec868b98a2cd506c30b1dc3784f15888e772` |
| `lib/markdown-list-continuation.ts` | `ee378e9e96f2a83ecbc28799e8c1d38c1801702f672ceba5a1cb7107ab4ba1ea` |
| `app/globals.css`                   | `14f7d5e6eb1521a1d56adfe7444c7c783ec27e869c3686f25f4573a1fdd424ea` |
| `package-lock.json`                 | `a6cfc4e58ae99e4bb0404fcff60d0edd2a68b9bce55f3f963b996320285b7c17` |

原文件可由 `https://github.com/agegr/pi-web/blob/7c0778a8bc7342f1ededc6f5fb190dc6f4e43044/<上游路径>` 查阅。

`react-markdown@10.1.0` 与 `remark-gfm@4.0.1` 精确版本取自该提交的公开 npm 锁文件；React、Vite、Tailwind 与类型版本沿用 tyde 现有版本。仅引入这些前端渲染依赖，不复制上游依赖清单、安装脚本或锁文件；最终依赖树由仓库根 `pnpm-lock.yaml` 管理。
