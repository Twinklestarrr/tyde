# release 跨仓自动发布

工作流随本次代码整理纳入 `txbo/tyde:release`；跨仓生产同步默认关闭，本次不配置凭据或启用生产同步。未来显式启用后链路如下：

```text
git push origin HEAD:release
  → txbo/tyde:release 的 GitHub Actions
  → 普通 merge 到 Twinklestarrr/tyde:main，并推送合并结果
  → Vercel tyde 的 Production 部署
  → 构建成功后更新 aact.pw
```

只需在源仓库放置 [工作流](../.github/workflows/sync-release-to-upstream.yml)，不需要在目标仓库另建 release 分支。Vercel 保持现有 `Twinklestarrr/tyde` 仓库及 `main` 生产分支设置。

`release` 是唯一代码来源，生产 `main` 只消费经过验证的 release。生产修复必须先回流 release；自动合并后的完整文件树须与 release 相同，否则停止推送，不把目标分支独有代码悄悄带入生产。

## 一次性启用

1. 用 `Twinklestarrr` 账号打开 [Fine-grained token 创建页](https://github.com/settings/personal-access-tokens/new)。Resource owner 选 `Twinklestarrr`，Repository access 仅选 `Twinklestarrr/tyde`，设置有效期。Repository permissions 配置 `Contents: Read and write` 及 `Workflows: Read and write`，其余不额外授予。Workflows 权限用于同步本工作流文件。不要将 token 写入代码或发到聊天中。
2. 打开 [txbo/tyde 的 Actions repository secrets](https://github.com/txbo/tyde/settings/secrets/actions)，创建名为 `SYNC_UPSTREAM_TOKEN` 的 repository secret，值为上一步 token。源仓库读取使用自身只读 `GITHUB_TOKEN`，该 secret 只授权目标仓库。
3. 源仓库 Actions 设置需允许运行工作流及官方 `actions/checkout`。在 [txbo/tyde 的 Actions repository variables](https://github.com/txbo/tyde/settings/variables/actions) 创建 `ENABLE_UPSTREAM_SYNC`，值为 `true`，再将经过验证的代码推送到 `txbo/tyde:release`。变量未设置或不等于 `true` 时，同步任务跳过；仅提交工作流或配置 secret 都不会启用生产同步。不要求先把工作流放到源仓库 main。工作流合并进入目标仓库后，仓库名称条件会阻止它在目标仓库运行。
4. 在 [源仓库 Actions](https://github.com/txbo/tyde/actions) 确认同步成功；再查看 [Vercel tyde 部署](https://vercel.com/star-64fb/tyde/deployments)，确认 Source 为 `main`，包含此次自动合并提交，Environment 为 Production，状态为 Ready，再检查 `aact.pw`。

目标仓库 main 当前无分支保护或 ruleset，普通 push 可用；以后若改为必须走 PR，本工作流会失败，需要同时调整发布流程，不能通过强推绕过。

## 合并和失败处理

- 使用常规非快进 merge，保留双方已有提交历史，随后检查结果树必须等于 release。目标 main 独有且未回流 release 的内容会阻断推送。新合并提交以目标账号 `Twinklestarrr` 的 GitHub noreply 身份署名，并在消息中标记 automated，沿用当前 Vercel 关联账号；源提交作者不变。
- 不使用强推、镜像、强制覆盖冲突或无关历史合并。冲突、缺少 secret、token 过期或目标 main 在同步期间被其他人推进时，任务失败，不覆盖目标分支；处理原因后在 Actions 重跑失败任务。
- 同步任务串行执行，读取开始执行时最新的 release。连续推送可能合并为发布最新状态；旧任务重跑也读取当前 release，GitHub 队列顺序不会使生产回退。
- 该工作流不执行自动化测试或数据库迁移。推送 release 前仍须完成改动对应的验证；Vercel 构建失败不会将失败构建切为现有生产域名。
- 没有新提交需要合并时不会制造空提交，因此不会凭空触发新的生产部署。

## 本次核对和验证

2026-10-28 整理前只读快照：源 release 为 `175fca4`，目标 main 为 `16da92d`，具有共同历史。目标独有 2 个提交（包含桌面可信来源修复），源独有 8 个提交；独立临时 Git 库模拟常规合并无冲突。修复在开发分支已有等价提交 `8b43aa1`，当时尚未进入 release；本次需将开发改动和最新 release 合并验证后发布，使修复先进入 release。不能用源 release 强制替换目标 main，也不能依赖目标 main 长期保存 release 缺失的修复。

整理前本地开发分支与 `origin/release` 已分叉（当时领先 51、落后 32），且有未提交业务修改。本次先整理待发布改动、合并最新 `origin/release` 并验证，再仅普通 push 到 `origin/release`；不直接推送两个仓库的 main，不用 `--force` 跳过分叉。

本次合并验证：`pnpm test:features` 的10阶段完整复跑通过，包括233核心、718后端单测、167页面（无失败/跳过/重试）、189 Agent服务和89 Agent Web；`pnpm typecheck`、`pnpm lint`、变更文件格式检查及 `pnpm build:vercel` 通过。首次核心运行有1项 Electron 启动脚本用例失败，单项及整套复跑均通过，未放宽超时。未执行数据库集成、迁移、seed、真实模型或生产部署。源仓库启用变量和同步 secret 均未配置，跨仓生产同步保持关闭。

本地验证命令（仅临时本地 Git 仓库，无网络、凭据或部署）：

```sh
node --test tests/release-sync.test.mjs
```

该验证覆盖已回流修复的双历史合并、重复运行无空提交、未回流目标独有内容不推送、冲突不推送及远程并发更新不被覆盖；不等同于 GitHub Actions 或 Vercel 已真实跑通。真实链路须在 secret 和启用变量配置并首次推送后核验。

依据：[GITHUB_TOKEN 范围](https://docs.github.com/en/actions/concepts/security/github_token)、[token 权限](https://docs.github.com/en/rest/repos/contents)、[Repository secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)、[GitHub 并发规则](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[Vercel Git 部署](https://vercel.com/docs/git)、[Vercel 提交归属](https://vercel.com/docs/deployments/troubleshoot-project-collaboration)。
