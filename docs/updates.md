# 应用与插件更新

项目仓库名为 `claude-session-cache-keeper`，应用和鱼形循环 Logo 使用品牌短名 **CacheKeeper**。已有插件 ID `session-cache-keeper@yxkong-cache-tools` 保持稳定。

## 使用

在窗口右上角或托盘菜单打开“检查更新”。桌面应用和连接插件分别显示安装版本、最新版本和下载按钮。插件可独立下载，无需再次下载整个应用。首次安装连接插件也可使用应用自带的副本；更新检查无法读取安装状态时会明确显示。

下载不修改会话开关。安装插件前，等待相关 Claude 任务结束并停止保活。安装只更新磁盘中的插件，不发送重载命令、不重启 Claude。目标会话手动重载后，以列表里的执行器版本确认加载；旧模块未替换时，待任务完成再重启 Claude。每条新连接仍默认关闭，由用户单独开启。

当前本地包使用临时签名，应用更新采用“下载新版 → 打开下载目录 → 手动替换”。正式签名的 macOS、Windows 原生安装包和 Linux AppImage 可使用原生更新器；用户点击安装前不会自动退出或安装。macOS 的原生更新依赖发布签名与公证，Windows 自动安装构建要求签名。Linux tar.gz 和 Windows ZIP 保留手动替换路径。

0.2.0 没有远程更新入口，首次需手动安装 0.3.0 或更高版本。仓库创建并发布第一个完整 Release 后，远程检查才会返回可用版本；没有公开版本、限流、断网或清单缺失均显示原因，不显示为更新成功。

## 发布配置

`release-config.json` 是更新仓库、桥接协议和最低应用版本的配置入口。当前目标为 `yxkong/claude-session-cache-keeper`。应用版本在 `package.json`，插件版本在 `plugin/.claude-plugin/plugin.json`；执行器报告版本须与插件清单一致，发布包生成器会核对。

`npm run release:metadata` 为本地三端运行包生成 `cachekeeper-update.json`、独立插件 JSON 包及 `SHA256SUMS.txt`。清单要求三个平台的应用包齐全。插件包仅允许固定的八个文件，安装前校验完整文件集、身份、协议、最低应用版本、大小和 SHA-256。安装失败恢复旧目录，内置旧版本不能覆盖已安装的新版本。

原生安装器由 `.github/workflows/build.yml` 构建。普通手动运行只产生构建产物；推送与应用版本一致的 `v*` 标签，或手动勾选发布选项，才会上传 GitHub Release。三个系统构建全部完成后，统一生成清单、上传到草稿并最后公开；已公开的同名版本拒绝覆盖。发布仓库必须与更新配置一致。

原生构建使用 `electron-builder.config.cjs` 从同一配置生成更新源。macOS 同时构建 DMG 和更新需要的 ZIP，Windows 构建 NSIS，Linux 构建 AppImage。签名凭据使用 GitHub Actions secrets：Mac 使用 `MAC_CSC_LINK`、`MAC_CSC_KEY_PASSWORD`、`APPLE_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`APPLE_TEAM_ID`；Windows 使用 `WINDOWS_CSC_LINK`、`WINDOWS_CSC_KEY_PASSWORD`。缺少签名时产物使用手动替换流程，插件远程更新仍可独立使用。

## 验证边界

本地 HTTP 模拟发布覆盖真实格式清单、下载校验、独立插件安装、工作期间拦截与手动应用包下载；原生更新器以模拟事件核对进度、摘要和安装错误恢复。以上不等于真实 GitHub Release、Apple 公证或跨版本签名升级验证。实际结果见 `verification.md`。

参考：[electron-updater 26 文档](https://www.electron.build/v26/docs/features/auto-update/)、[Claude 插件更新](https://code.claude.com/docs/en/discover-plugins#keep-plugins-updated)。

0.2.1 执行器支持自定义正整数尝试次数，6 次为默认建议值。对仍在运行的旧执行器设置超过 6 次时，应用会提示先更新并重载，避免配置被旧模块拒绝。会话列表蓝点表示工作中、绿点表示在线、灰点表示离线；这些标记与是否开启保活分别判断。
