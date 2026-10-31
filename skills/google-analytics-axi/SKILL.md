---
name: google-analytics-axi
description: Read-only Google Analytics 4 and Search Console data for agents.
---

# google-analytics-axi

Use `google-analytics-axi` for read-only Google Analytics 4 and Search Console reporting. Output is compact TOON. Run `google-analytics-axi setup` for browser OAuth, `google-analytics-axi setup service-account <key.json>` for a service account, `google-analytics-axi setup status` to inspect authentication, and `google-analytics-axi setup uninstall` to remove it. OAuth uses read-only Analytics and Search Console scopes and stores the refresh token in the OS keychain.
