# 应用与插件更新

仓库为 `yxkong/claude-session-cache-keeper`，应用品牌为 CacheKeeper。插件 ID `session-cache-keeper@yxkong-cache-tools` 和桥接协议 1 保持稳定。

## 使用

右上角或托盘打开“检查更新”，桌面应用和连接插件分别显示当前版本、最新版本和下载按钮。检查和下载不修改会话开关。插件可以独立下载；首次安装可直接使用应用自带副本。

安装插件前等待 Claude 任务结束并停止相关保活。应用只更新磁盘内容，不自动发送重载命令或重启 Claude。用户在目标会话重载后，以列表报告版本确认；旧模块未替换时，待任务结束后重启执行器。每条新连接仍默认关闭。

## 0.3.0 → 0.4.0

0.3.0 Electron 应用继续读取 `cachekeeper-update.json`。0.4.0 保留该清单和安装包命名，因此旧应用可以下载并校验新版安装包，再由用户手动替换。不会用 Electron 原生更新器直接安装 Tauri 程序。现有会话数据目录、控制格式和插件 ID 保持兼容。

## 两种应用更新方式

默认构建：从 GitHub 下载当前系统的安装包，限制来源和重定向、核验大小与 SHA-256，再打开下载目录手动安装。

签名构建：`release-config.json` 配置 `tauriUpdaterPublicKey`，CI 注入 `TAURI_SIGNING_PRIVATE_KEY` 和可选密码。Tauri 原生更新额外校验签名，分开下载与安装，安装前再次校验并确认会话空闲；不会在退出时偷偷安装。Linux 原生更新只在 AppImage 中启用。更新签名与 Apple/Windows 系统签名是不同机制，系统签名和公证仍需对应发布凭据。

没有配置更新公钥时不生成原生更新清单；签名配置存在但缺少任何必需平台签名时，发布清单生成失败，不能公开半成品。仓库源代码不保存私钥。当前迁移不创建、修改或上传任何签名凭据。

## 发布与兼容

应用版本来自 `package.json` / Cargo，插件版本来自插件清单和执行器报告。`release-config.json` 是仓库、协议、最低应用版本和可选更新公钥的配置入口。

`npm run package` 在当前系统生成原生包；Mac 默认 Intel + Apple Silicon 通用 DMG，Windows 为 NSIS，Linux 为 DEB 和 AppImage。`npm run verify` 检查体积预算及已生成包，Mac 还核验架构、签名、资源一致性、无独立运行时及本机路径泄漏。

三端 CI 全部构建完成后，`npm run release:metadata -- --directory=release/native` 生成兼容清单、独立八文件插件包、可选 `tauri-latest.json` 和 SHA256SUMS。插件下载校验身份、协议、最低应用版本、完整文件集、大小与摘要；拒绝降级，安装失败恢复 marketplace。

手动 CI 默认只构建。发布需显式选择发布或推送版本标签；先上传草稿所有附件，最后公开。已公开的同名版本拒绝覆盖。跨版本原生升级、系统签名与各目标系统的实际运行证据见 `verification.md`。
