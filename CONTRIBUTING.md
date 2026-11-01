# Contributing

Keep changes focused on per-session cache control. Do not turn new sessions on automatically, ignore the configured attempt budget, hide failed API calls, or represent a generated package as a target-system runtime test.

Use synthetic sessions and `CACHE_KEEPER_DATA_DIR` for tests. Never include real conversation files, API credentials, project paths or personal account settings in fixtures, issues, screenshots or release archives.

Run `npm run build`, `npm test`, `npm run test:rust`, and the relevant connector tests. For platform-specific changes, report the exact OS and architecture exercised; mark target systems that were not run. Preserve MIT attribution for derived code.

Network access belongs in the Rust GitHub updater. Do not add arbitrary renderer file access or shell command interpolation. Renderer inputs must pass the main-process contract, and connector credentials must remain with Claude Code.
