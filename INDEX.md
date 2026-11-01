# Source map

项目：CacheKeeper / claude-session-cache-keeper；类型：engineering；应用版本：0.3.0；连接插件：0.2.1。

- `docs/contract.md`：用户行为、平台与验收边界。
- `docs/updates.md`、`release-config.json`：更新行为、发布配置与兼容边界。
- `plugin/hooks/policy.ts`：保活状态机及参数。
- `plugin/hooks/register.ts`：Claude 执行器桥接与会话生命周期。
- `app/core/`：本地状态仓库、标题、CLI 安装与 GitHub Release 更新。
- `app/main.mjs`、`app/preload.cjs`：Electron 生命周期与受限 IPC。
- `app/renderer/`：界面和交互。
- `assets/brand/`：品牌主图；`scripts/icons.mjs` 生成各端图标。
- `scripts/package.mjs`：跨平台运行包；`.github/workflows/build.yml`：原生安装器构建。
- `docs/verification.md`、`release/verification.json`：人工说明与机器校验结果；构建、启动、视觉验收分开记录。
- `test/`：桌面核心回归；`plugin/tests/`：执行器回归。

验证：`npm test`、`npm run test:plugin`、`npm run build`、`npm run package`、`npm run verify`。
