# CacheKeeper · by yxkong

<img src="assets/icons/icon-128.png" width="88" alt="CacheKeeper fish-loop icon">

Choose which Claude Code sessions to keep warm. Set a random interval, cap idle attempts, and see the actual cache-token usage. Every new connection starts **off**.

CacheKeeper is an independent desktop application for macOS, Windows and Linux. The application bundles its Claude Code connector, so people download one desktop package and install the connector from the app. API calls use the original session's model and credentials; the app never asks for an API key.

[中文使用说明](docs/quickstart.md) · [Behavior and compatibility](docs/contract.md) · [Attribution](THIRD_PARTY_NOTICES.md)

## Defaults

- Random interval: **260–280 seconds** for a 5-minute cache window.
- Maximum: **6 attempts per idle stretch**. Normal work resets the budget; keepalive calls do not.
- Optional minimum cached-token threshold; each session has its own switch and settings.
- Stop after a failed request, cache miss, expired window or exhausted attempt budget.

Keepalive requests have a cost. The interface reports cache reads, writes and output tokens; your API provider determines actual billing and cache behavior. There is no promise that every provider will preserve the same cache prefix.

## Use

Install and sign in to Claude Code CLI first. Open CacheKeeper, install the bundled connector, reload plugins in the selected Code session, then check the reported executor version before enabling that connection. Older Desktop sessions may need an executor restart after their current work finishes. Ordinary Claude Chat conversations are outside this connector's scope.

The local release artifacts are a macOS universal DMG, Windows x64 portable ZIP and Linux x64 tar.gz. The included GitHub Actions workflow builds native macOS DMG, Windows NSIS and Linux AppImage installers on their respective hosts. A generated archive is not proof of target-system runtime compatibility; see `release/verification.json` for the actual validation status.

## Build from source

Requires Node.js 22.18 or later. Dependency versions are pinned in `package-lock.json`.

```sh
npm ci
npm run icons
npm run build
npm test
npm run test:plugin
npm run package
npm run verify
```

`npm run test:plugin` requires a Claude Code CLI version that includes the hooks-module test harness. `npm run package` builds the three local runtime packages on macOS; select one with `npm run package -- --target=mac`, `windows`, or `linux`. macOS packaging needs Apple's command-line tools. Native installers can also be built with the included `electron-builder.yml` on each target host.

## Data and privacy

The connector and app exchange status and controls under the user's `.cache-keeper` directory. `CACHE_KEEPER_DATA_DIR` overrides it for isolated testing. Session status includes IDs, project paths, a short preview and token counts, but no API key or complete transcript. The app reads local transcript-tail title metadata to display recognizable names and respects `CLAUDE_CONFIG_DIR` for transcript lookup.

When migrating from the earlier Mac prototype, the installer stops legacy controls and disables the old connector before installing the new one. Legacy connections are visible but cannot be enabled from this app. Close the older management application before migration.

Closing the window leaves the app in the tray; a normal quit stops known keepalive controls. A forced process termination may leave the remaining attempts running. Already-sent requests cannot be retracted.

## Distribution status

Local builds are not Developer ID-notarized or Windows publisher-signed. Signing identities and credentials are not included. GitHub creation, remote publication and signing are separate release steps.

MIT licensed. The request-clock, session-fork and cache-hit mechanisms build on [cache-tax](https://github.com/karanb192/cache-tax); its copyright and license are preserved. The new identity uses an original fish/refresh-loop mark inspired by yxkong's personal brand and has no affiliation with Anthropic.

## 更新

项目仓库名为 `claude-session-cache-keeper`，应用和 Logo 品牌短名为 **CacheKeeper**。0.3.0 增加“检查更新”入口，应用和连接插件分别下载、按需安装。插件更新不会自动开启会话；任务完成并停止保活后安装，再在目标 Claude 会话手动重载。首次 GitHub Release 发布后远程版本才可用。当前本地应用包下载后需手动替换；正式签名原生包支持原生更新安装。详见 [更新说明](docs/updates.md)。
