# Contributing

Keep changes focused on per-session cache control. Do not turn new sessions on automatically, remove the attempt cap, hide failed API calls, or represent a generated package as a target-system runtime test.

Use synthetic sessions and `CACHE_KEEPER_DATA_DIR` for tests. Never include real conversation files, API credentials, project paths or personal account settings in fixtures, issues, screenshots or release archives.

Run `npm test`, the relevant connector tests, and a build. For platform-specific changes, report the exact OS and architecture exercised; mark target systems that were not run. Preserve MIT attribution for derived code.

Do not add network access, arbitrary renderer file access or shell command interpolation. Renderer inputs must pass the main-process contract, and connector credentials must remain with Claude Code.
