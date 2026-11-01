# 0.4.0 Tauri 迁移验证

验收宿主为 macOS / Apple Silicon；以下为实现者自测。Windows/Linux 构建脚本已迁移，尚未提交并触发对应 CI，不能据此声称已产出或运行三端安装包。

| 检查 | 结果 | 实际边界 |
|---|---|---|
| Rust 桥接、安装、下载及 SDK 配置回归 | PASS，15 项 | 覆盖参数边界样例、单会话控制、旧连接、CLI 参数/超时、恢复、禁止降级、下载损坏及来源限制 |
| 组件与发布契约 | PASS，15 项 | 组件调用真实 Rust 测试进程；发布生成结果再交 Rust 消费者校验；错误消息正常显示 |
| Claude 连接插件 | PASS，30 项 | 使用合成模型、会话和请求，不发送真实 API 保活 |
| Mac 通用包 | PASS | DMG 11,544,443 字节，约 11 MiB；同时包含 x86_64 和 arm64 |
| Mac 包完整性 | PASS | ad-hoc 签名、资源与源码一致、无 Node/Chromium/测试程序、二进制不含本机主目录 |
| Mac 原生 WebView 启动与正常退出 | PASS | 成品在隔离目录读取两条合成会话，通过真实 IPC 回报界面加载，正常退出码 0 |
| 原生窗口点击与视觉 | NOT_RUN_LOCKED | Mac 锁屏，尚不能使用桌面工具操作；组件验证不替代此项 |
| Windows/Linux 包与实际运行 | NOT_RUN | 需获准提交推送后运行三端 CI；目标系统实际交互另验 |
| 原生签名跨版本升级、系统签名/公证 | NOT_RUN | 未创建或配置发布签名密钥；当前应用更新使用校验下载后手动安装 |
| 真实会话与 API | NOT_RUN | 保留原运行应用，没有重启 Claude、安装真实插件或开启真实保活 |

原生验收曾捕获未配置更新插件时的启动失败；已补实际 SDK 配置反序列化回归并验证成品启动通过。Tauri 字符串错误曾导致界面消息丢失，保留了先失败后通过的接口适配回归。Mac DMG 使用磁盘映像工具生成，避免依赖 Finder 布局及解锁状态。

复现入口：`npm run build`、`npm test`、`npm run test:rust`、`npm run test:plugin`、`npm run package`、`npm run verify`。原生成品启动脚本为 `scripts/smoke-launch.mjs --exit-after-ready`，必须以隔离数据运行。构建报告位于 `release/native/`，启动报告位于 `.tmp/smoke-evidence.json`。

## 0.3.0 历史说明

以下原始记录形成于 0.3.0 发布前，保留为历史测试记录，不代表当前远端状态。0.3.0 后来已发布至 [GitHub Release](https://github.com/yxkong/claude-session-cache-keeper/releases/tag/v0.3.0)。

# 0.3.0 验证记录

首次 GitHub 原生构建中，Windows NSIS 与 Linux AppImage 通过，Mac 因缺失 secret 被注入为空的 `CSC_LINK`，进而被构建器解析为项目目录而失败。配置层将空引用视为缺省，实际证书引用保持原值；已通过先失败后通过的隔离配置回归保护。三端最终构建与发布状态以 GitHub Actions 和 Release 为准。

三端构建通过后，首次汇总未识别 AppImage 的 `x86_64` 后缀，清单完整性校验阻止了发布。生成器现将其归一为协议中的 `x64`，HTTP 发布集成用例改用真实命名格式，先复现缺失平台错误再验证修复。

构建宿主：macOS / Apple Silicon，Node.js 22.21.0，Electron 45.2.1。应用版本 0.3.0，连接插件 0.2.1；机器结果见 `release/verification.json`。

| 检查 | 结果 | 证据边界 |
|---|---|---|
| 桌面、更新与组件回归 | PASS，28 项 | 包含真实格式 HTTP 模拟发布、摘要校验、独立插件安装、工作拦截、回退与降级保护、12 次预算、颜色与无障碍状态 |
| 连接插件回归 | PASS，30 项 | 默认六次预算、正整数配置、TTL、生命周期及开关隔离；模型为测试替身 |
| 隔离真实 CLI | PASS | 0.2.1 安装、列出和再次更新，隔离 HOME 与配置目录 |
| 三端包 | 构建 PASS | macOS universal DMG、Windows x64 ZIP、Linux x64 tar.gz；完整性结果见机器报告 |
| Mac 原生窗口 | PASS_AGENT | 实际成品，蓝色工作状态、绿色在线状态、紧凑列表、保存 12 次保持关闭，其他会话无控制文件 |
| 更新窗口 | PASS_AGENT | 真实 GitHub 请求返回未发布提示；不展示为已更新 |
| 原生自动安装适配 | PASS，模拟事件 | 下载进度、摘要校验、安装失败恢复退出状态；不是签名升级实测 |
| GitHub Actions、正式 Release | NOT_RUN | 仓库尚未创建，未触发 CI 或发布 |
| Apple 发布签名与公证、Windows 签名 | NOT_RUN | 本地 Mac 为 ad-hoc，应用下载后手动替换 |
| Windows/Linux 实机、真实 API 保活 | NOT_RUN | 未开启用户真实会话或发送收费探测 |

次数策略和在线标识先通过失败用例复现，再修改策略真源及界面。6 为默认建议值，正整数配置没有业务上限；本轮仍在配置次数后停止。旧执行器缺少自定义预算能力时，保存超过六次会提示先更新并重载，防止旧模块拒绝配置而持续等待。工作状态独立于保活开关，在线但未保活的会话显示绿色；正常工作显示蓝色。

新增更新依赖的许可由锁定生产依赖生成。lazy-val 1.0.5 的 npm 包未附 LICENSE，已保留其 MIT 声明、作者和上游地址，并按声明补入标准许可文本；以后发现未覆盖的缺失许可会使构建失败。运行依赖复制保留相对软链接。

复现命令：`npm run build`、`npm test`、`npm run test:plugin`、`npm run package`、`npm run release:metadata`、`npm run verify`。原生签名升级和公开发布需要独立证据，HTTP 模拟发布不能替代。

# 0.2.0 历史验证记录

构建宿主：macOS / Apple Silicon；Node.js 22.21.0；Electron 45.2.1。构建结果以 `release/verification.json` 和 `release/SHA256SUMS.txt` 为准。

| 检查 | 结果 | 边界 |
|---|---|---|
| 桌面核心、组件与打包回归 | PASS，15 项 | 合成会话；单会话开关、非法参数时停止、CLI 参数隔离与失败迁移、Mac 软链接可迁移与重复构建、紧凑列表刷新焦点与提示 |
| 连接插件回归 | PASS，30 项 | Claude 插件测试运行器；生命周期、六次预算、TTL、缓存未命中与身份切换；没有真实 API 请求 |
| macOS 通用 DMG | PASS，构建与完整性 | Intel / Apple Silicon 双架构；ad-hoc 签名，不含 Developer ID 或公证 |
| Windows x64 ZIP | PASS，构建与完整性 | 便携运行包；目标系统运行 NOT_RUN |
| Linux x64 tar.gz | PASS，构建与完整性 | 便携运行包；目标系统运行 NOT_RUN |
| Mac 成品包启动与退出 | PASS | Apple Silicon；隔离数据、演示模式；观察到 ready 并正常退出，未发真实 API 请求 |
| Mac 菜单栏原生图标参数 | PASS | 成品原生图像报告 18×18pt、template=true；使用透明 PNG；系统菜单栏视觉复核待解锁 |
| Mac 最终窗口与主链路自检 | PASS_AGENT | 成品原生窗口；侧栏品牌、单行列表、搜索、单会话保存与启停、错误参数下停止、旧版限制；界面动作同时核对控制文件 |
| 隔离配置的真实 CLI 安装 | PASS | 实际安装、列出、更新 0.2.0 插件；隔离 HOME 与配置目录，无真实会话或认证变更 |
| 原生安装器 CI | NOT_RUN | 已提供 macOS DMG、Windows NSIS、Linux AppImage 配置，未推送或运行 GitHub Actions |
| 新版真实 API 保活 | NOT_RUN | 没有开启用户真实会话，也没有发送收费探测请求 |
| 公共发布签名 / 公证、GitHub 发布 | NOT_RUN | 不属于本地构建操作 |

复现：`npm ci`、`npm run icons`、`npm run build`、`npm test`、`npm run test:plugin`、`npm run package`、`npm run verify`。连接插件测试需要本机存在支持 hooks modules 的 Claude Code CLI。验证脚本保留实际测试日志摘要，比较打包后的业务代码、连接插件资源与当前构建，检查各平台二进制格式、图标、权限与归档，并生成 SHA-256 和源码 ZIP。

源码包由显式白名单生成，不包含依赖目录、构建缓存、本机测试目录或会话数据。检查覆盖当前用户主目录路径及常见凭据格式，不代表能识别所有敏感信息。

构建回归：Node 默认复制软链接会把 Mac 框架链接改写为本机绝对路径，重复使用暂存目录还会触发复制错误。修正为每次重建独立暂存目录，并原样保留相对链接；回归用例先复现错误路径，修正后核对重复构建及框架内容。完整性脚本同时检查输出应用和 DMG 暂存应用内的链接，阻止依赖构建机路径的包交付。

Mac 启动回归：初始 ad-hoc 包虽通过静态签名验证，实际启动仍被库验证拒绝。根因为 osx-sign 的运行时选项按文件生效，根级配置未生效。改为逐文件设置本地签名参数，仅保留 JIT entitlement；启动冒烟必须观察到应用 ready 且正常退出，不能把信号崩溃算作成功。

界面调整：初版品牌栏 106px、窗口图标 53px，菜单栏使用带底色的 32px 彩色图标，品牌视觉权重过大。最终将 24px Logo、名称和署名移入左侧栏，顶部仅保留 38px 工具栏；会话列表为约 36px 单行标题与状态点，项目、ID 和文字状态保留在悬停提示及详情。主开关移至会话标题旁，用量区减少卡片装饰；Mac 菜单栏采用独立 18pt 透明单色模板。

解锁后，最终成品窗口已由 Agent 操作并检查：保存配置保持关闭、只开启 A、非法参数仍可停止 A、停止保留有效配置、B 保持默认且不产生控制文件、中文搜索、旧版连接不能开启、切换会话后清除上一条确认提示。15 项桌面回归通过。原生窗口自检不是独立人工验收；Windows/Linux 实机、Mac 系统菜单栏外观与真实 API 仍为 NOT_RUN。临时截图仅保留在本机 `.tmp/visual-checks/`，不进入源码包；机器报告按实际 app.asar 摘要绑定自检结果。

列表回归：每两秒重建未变化的行会丢失键盘焦点并打断悬停提示；改为仅在可见内容或选中项变化时更新，并恢复对应行焦点。跨会话提示也必须随切换清除，防止把 A 的停止确认显示成 B 的结果。两类行为均先通过失败用例复现，再修正并验证通过。

下载故障：Electron 构建会核对远端校验文件，已有 ZIP 缓存仍可能访问 GitHub。直连超时后使用本机已配置的下载代理重新构建成功；未跳过校验，也未把本机代理地址写入源码。
