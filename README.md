# CacheKeeper · by yxkong

按会话管理 Claude Code 的 API 提示词缓存续热。每条会话单独选择、单独设置，默认关闭；桌面应用不持有 API Key。

0.4.0 将桌面底座迁移至 **Tauri 2 + Rust + 系统 WebView**，保留原有界面和连接插件。该版本尚待发布；公开安装包见 [Releases](https://github.com/yxkong/claude-session-cache-keeper/releases)。

## 使用

1. 下载适合系统的安装包：Mac 通用 DMG、Windows 安装程序、Linux DEB 或 AppImage。
2. 安装并登录 Claude Code CLI，在应用内点击“安装连接插件”。
3. 在目标 Code 会话执行 `/reload-plugins`，以应用显示的执行器版本确认连接。
4. 选择需要保活的会话，设置参数后单独开启。

默认随机间隔 260～280 秒，支持 30～280 秒；建议每段空闲尝试 6 次，允许其他正整数；可设置最小缓存 token 门槛。正常工作请求重置预算，保活请求不重置。次数用完、过期、失败或未命中时停止本轮。缓存是否命中及实际费用取决于原会话的 API 供应源。

右上角“检查更新”分别管理应用和连接插件。插件安装后需要在目标会话手动重载，不会自动重启 Claude。详见 [使用说明](docs/quickstart.md)和[更新说明](docs/updates.md)。

## 本地构建

需要 Node.js 22、Rust stable，以及 Tauri 对应平台的原生开发依赖。Mac 通用包还需要 `aarch64-apple-darwin` 与 `x86_64-apple-darwin` Rust 标准库目标。

```sh
npm ci
npm run build
npm test
npm run test:rust
npm run package
npm run verify
```

安装包位于 `release/native/`。Windows、Linux 由各自的原生 CI 构建；构建成功与实际运行分别记录在[验证记录](docs/verification.md)。

## 开源与归属

MIT。缓存请求时钟、会话 fork 和缓存命中判定改造自 [cache-tax](https://github.com/karanb192/cache-tax)，保留原作者版权。完整归属见 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.md)。
