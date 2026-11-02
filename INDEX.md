# Source map

项目：CacheKeeper / claude-session-cache-keeper；类型：engineering；应用版本：0.4.0；连接插件：0.2.2。

- `docs/contract.md`：用户行为、平台与验收边界。
- `docs/updates.md`、`release-config.json`：更新行为、发布配置与兼容边界。
- `plugin/hooks/policy.ts`：保活状态机及参数。
- `plugin/hooks/register.ts`：Claude 执行器桥接与会话生命周期。
- `src-tauri/src/bridge.rs`：会话、标题、控制校验和原子写入。
- `src-tauri/src/installer.rs`：CLI 发现、安装及迁移恢复。
- `src-tauri/src/release.rs`、`updates.rs`：发布契约、下载校验及应用/插件更新。
- `src-tauri/src/lib.rs`、`tauri.conf.json`：Tauri 生命周期、托盘及受限 IPC。
- `app/renderer/`：界面和交互。
- `app/core/product.json`、`src-tauri/src/support.rs`：产品与公众号资料、首次使用偏好及固定产品链接。
- `assets/brand/`：品牌主图；`scripts/icons.mjs` 生成各端图标。
- `scripts/package.mjs`：跨平台运行包；`.github/workflows/build.yml`：原生安装器构建。
- `docs/verification.md`、`release/verification.json`：人工说明与机器校验结果；构建、启动、视觉验收分开记录。
- `src-tauri/tests/`：Rust 行为回归；`test/`：通过 Rust 桥接的组件与发布契约测试；`plugin/tests/`：执行器回归。

验证：`npm test`、`npm run test:rust`、`npm run test:plugin`、`npm run build`、`npm run package`、`npm run verify`。
