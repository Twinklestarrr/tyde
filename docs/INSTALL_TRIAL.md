# tyde 内部试用安装

安装包与校验和由项目维护者提供。试用包未完成 Apple Developer ID 签名、公证或 Windows 发布者签名；系统可能提示来源未知。请核对可信来源、版本和 SHA-256。测试人员无需安装 Node.js、pnpm 或 PostgreSQL。

## macOS

支持 Apple Silicon / Intel，项目目标最低 macOS 12；具体兼容性以验证记录为准。默认提供 universal DMG，不需要自行选芯片。

1. 打开 DMG，将 **tyde** 拖入 Applications（应用程序）。
2. 从 Applications 打开应用。
3. 如提示开发者无法验证或未公证，先关闭提示，进入“系统设置 → 隐私与安全性”。
4. 找到 tyde 被阻止的信息，选择“仍要打开 / Open Anyway”，按系统要求验证身份并再次确认。

若无允许按钮、被公司策略禁用或提示应用已损坏，请联系维护者/管理员核对文件与签名。不要全局关闭 Gatekeeper、SIP，也不要使用终端命令批量解除隔离。

[Apple 官方说明](https://support.apple.com/102445)。

## Windows

默认支持 Windows x64，建议使用受支持的 Windows 11。双击 `tyde-版本-win-x64.exe`，按向导安装；默认按当前用户安装。

如果 SmartScreen 显示“Windows 已保护你的电脑”，在核对可信来源后选择“更多信息 / More info”→“仍要运行 / Run anyway”（系统提供该选项时）。如提示未知发布者，应显示与本项目相符的文件来源。

如果公司策略或 Smart App Control 不提供允许选项，请由管理员处理设备授信。不要关闭 Defender 或安全软件。恶意软件告警和文件损坏需单独排查，不能当作普通信誉提示忽略。

[Microsoft SmartScreen 说明](https://learn.microsoft.com/en-us/windows/security/threat-protection/microsoft-defender-smartscreen/microsoft-defender-smartscreen-overview)。

## 开始试用

1. 确认维护者说明的测试后端已上线且本机可访问；提示服务或数据库不可用时联系维护者。
2. 输入约定的大陆手机号，点击“获取验证码”。
3. 输入固定验证码 **095270**。试用不会发送真实短信，也不验证号码归属。
4. 新手机号验证后填写姓名、可选昵称、密码与确认密码；注册成功后使用密码登录。
5. 登录后进入工作台，在个人中心查看资料。关闭重开可恢复有效会话；主动退出撤销当前会话。

前后端环境地址随安装包固定。若安装包注明“本地联调”，它连接安装者自己的 `127.0.0.1:3000`，不适用于跨电脑认证试用；请向维护者索取正确测试环境包。

反馈问题时提供系统版本、芯片架构、应用版本、错误提示和请求编号；不要提供验证码以外的令牌、密码或 `.env`。
