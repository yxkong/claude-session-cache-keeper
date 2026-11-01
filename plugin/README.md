# CacheKeeper session connector

This connector publishes each Claude Code session to the local CacheKeeper desktop application. Every new connection starts disabled. Select one session in the application and explicitly enable it to keep that session's prompt cache warm. Other sessions remain disabled.

The default delay is randomized between 260 and 280 seconds, with at most six attempts during one idle period. Normal work resets the idle budget; keepalive requests do not. Failures, expired caches, cache misses and the attempt limit stop the current round. You can set a minimum cache token threshold in the application.

Requires a Claude Code version supporting hooks modules and an API provider supporting prompt caching. Requests use the original session's model and credentials and can incur charges. No API key is stored in the bridge files. Install this connector through the desktop application, then reload plugins in your Code session. If the existing process still reports an old connector version, restart it after its current work finishes.

This is an independent project by yxkong, derived in part from cache-tax under MIT. It is not affiliated with Anthropic. See the repository license and third-party notices for attribution.
