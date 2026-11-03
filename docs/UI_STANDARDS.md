# 业务界面规范

Web 与 Electron 共用 `apps/web`。沿用现有青色主题、React、Tailwind 和 shadcn/Radix，业务页面通过公共组件保持一致。

## 尺度与主题

唯一主题入口是 `apps/web/src/styles/global.css`。根字号保持 12px，Tailwind 的 `--spacing` 固定为 4px；`p-5`、`gap-4`、`size-11` 分别为 20px、16px、44px，不再随根字号缩小。

| 用途           | 标准                                                                |
| -------------- | ------------------------------------------------------------------- |
| 页面标题       | 24px / 34px，使用 PageHeader                                        |
| 弹窗标题       | 18px / 26px，由 Dialog 管理                                         |
| 卡片与区块标题 | 16px / 24px，使用 CardTitle                                         |
| 正文、字段值   | 13px / 20px                                                         |
| 标签、辅助信息 | 12px / 18px；极短标记可用 11px                                      |
| 圆角           | 输入框与按钮 8px；卡片与弹窗 12px                                   |
| 间距           | 优先 4/8/12/16/20/24/32px，卡片内边距 20px                          |
| 表格           | 表头 12px、单元格 13px；统一横向 16px、表头纵向 12px、正文纵向 14px |

颜色使用 `primary`、`muted`、`destructive` 等语义主题或现有成功/警告变量。主要操作用 Button 默认变体，次要操作用 outline/ghost；危险操作用 destructive 系列。认证提交按钮同样使用公共主题，不覆盖颜色与圆角。

## 公共组件

组件位于 `apps/web/src/components/ui/`：

- `page.tsx`：PageHeader，统一标题、说明与响应式操作区。
- `card.tsx`：Card、CardHeader、CardTitle、CardDescription、CardContent、CardFooter。Card 与 CardTitle 支持 asChild，保留 section/article/h3 等原生语义。
- `dialog.tsx`：Dialog，统一头部、正文滚动、可选操作区、焦点恢复及嵌套滚动锁。宽度 sm/md/lg/xl 分别为 480/680/960/1100px；由内容需要决定。busy 时禁止取消与关闭，背景点击默认不关闭。
- `table.tsx`：Table 系列，统一表格密度；横向滚动、业务列宽和可编辑网格的特殊单元格由页面管理。
- `pagination.tsx`：Pagination，统一计数、页码和上下页；可用 aria-label 区分多个分页区。
- `empty-state.tsx`：EmptyState、LoadingState，统一缺少数据和异步等待的反馈；错误继续使用 ErrorNotice/Alert。
- `search-input.tsx`：SearchInput，项目列表共用内嵌搜索图标和 40/44px 控件尺寸。需要显式查询时在输入框前缀区提供提交按钮，保留回车提交；即时本地筛选不增加查询请求。刷新紧邻搜索区，空列表在 Card 内居中展示说明和恢复操作。
- 已有 Button、Input、Textarea、Select、FormField 继续作为控件入口，按钮高度通过 size 选择。

OrganizationDialog、EntranceExamDialog 等保留业务接口的薄适配，内部复用公共 Dialog。新增同类页面不得再复制一套弹窗、分页或卡片外壳；样式差异应先判断是否属于现有变体。

## 保留的用途差异

个人主页保留 280px 资料侧栏与白底布局；项目任务页保留紧凑工具栏和卡片连续动效；认证页保留全屏品牌背景与悬浮卡片。复杂考试/阅卷内容可以用大弹窗，普通确认使用小弹窗。统一的是同类元素的视觉与交互规则。

独立 Agent UI 仍在 `apps/agent-web` 隔离维护，本次业务主题不覆盖其样式。

## 验证

修改公共尺度或外壳后，执行 Web 类型检查、ESLint、Prettier、Web/Electron 构建及前端契约回归。`ui-consistency.spec.ts` 校验桌面、375px 手机和横屏下的实际控件尺寸、标题层级、弹窗滚动、Esc/焦点恢复及页面溢出；考试既有回归覆盖嵌套弹窗、草稿和提交保护。测试使用隔离 HTTP 夹具，不连接业务数据库。
