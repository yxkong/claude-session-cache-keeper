# CacheKeeper 0.3.0

## 范围与验收

独立桌面应用包含连接插件。用户只下载对应系统的一个应用包，在应用中安装连接插件后，选择会话并单独开启保活。支持 macOS、Windows、Linux 的同一界面与本地文件协议；API 请求继续由 Claude Code 原会话发送，应用不持有 API Key。

保留默认随机 260～280 秒、默认建议连续空闲尝试 6 次、可选最小缓存 token 门槛。尝试次数允许正整数，不设业务上限，达到用户配置的次数后结束本轮。每条新连接默认关闭；保存配置不自动开启；正常请求重置预算，保活不重置。缓存未命中、失败、过期或次数耗尽时停止本轮。不能保证自定义 API 源的缓存命中或固定金额费用。

新执行器使用各系统用户主目录下的 `.cache-keeper/`，可由 `CACHE_KEEPER_DATA_DIR` 覆盖。macOS 应用可显示原生旧版的数据，但旧版连接仅允许停止；安装新版时停用旧插件与旧开关，避免两份执行器同时花费。安装失败时尝试恢复旧插件启用状态，保活开关保持停止，由用户决定是否重新开启；若新版无法确认停用，不重新启用旧版，报错让用户核查。

应用只显示已发布连接，按本机转录元数据显示真实标题。无标题时展示短预览和会话 ID。不会为找标题调用模型。UI 无 Node 权限，控制请求由主进程验证会话身份、在线状态和参数后原子写入；不接受 UI 提供的任意文件路径。

正常退出应用会停止已知连接；关闭窗口后留在托盘。强制退出仍可能保留已开启轮次的剩余尝试。插件更新后以会话实际报告的版本确认加载；旧 Desktop 会话热重载未生效时，任务结束后重启执行器。

## 结构与取舍

采用 Electron 45.2.1、Electron Packager 20.3.0 与无原生扩展的业务代码。它允许在当前 macOS 机器组装三端运行包，代价是分发体积增加。现有 SwiftUI 代码不作为新项目的第二套桌面实现。Tauri 的小体积有价值，但本机没有 Windows/Linux 原生构建环境，不能把跨平台源码宣称为已生成三端程序。

原有请求时钟、fork、缓存命中检查和回归用例来自 cache-tax 的改造版，保留 MIT 归属。参数验证由执行器状态机复用到桌面端。

参考：[Electron Packager](https://electron.github.io/packager/main/interfaces/Options.html)、[Electron 安全建议](https://www.electronjs.org/docs/latest/tutorial/security)、[Tauri Windows 构建边界](https://tauri.app/distribute/windows-installer/)。

## 交付与证据

- 本机生成 macOS 应用/DMG、Windows x64 ZIP 和 Linux x64 tar.gz 运行包。
- 原生安装器 CI 提供 Windows NSIS 与 Linux AppImage，未实际运行 CI 时标记 NOT_RUN。
- 使用合成数据验证桌面组件主链路、状态/控制隔离、CLI 错误与迁移、执行器状态机。原生窗口视觉验收与组件测试分别记录，见 `docs/verification.md`。
- Windows/Linux 的目标系统启动、安装器体验与真实 API 命中，没有实际运行证据时标记 NOT_RUN。
- Mac Developer ID/公证、Windows 签名和 GitHub 发布不包含在本地构建中。
