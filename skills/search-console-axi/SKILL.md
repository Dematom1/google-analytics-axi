---
name: search-console-axi
description: Read Google Search Console performance and inspect URL indexing.
---

# search-console-axi

Use `search-console-axi` for read-only Google Search Console reporting and URL inspection. Output is compact TOON. See the [README](../../README.md#authentication) for authentication setup.

Run `search-console-axi` for the default site's clicks, impressions, CTR, average position, top queries/pages, and low-CTR opportunities. Run `search-console-axi setup` to check access. Run `search-console-axi inspect <url> --site <site-url>` to inspect index status.

For agents, load the service-account JSON from a secret manager into `SEARCH_CONSOLE_AXI_SA_KEY`; never commit it. `GOOGLE_APPLICATION_CREDENTIALS` and user ADC are supported as fallbacks. Grant the service account Restricted access in Search Console. The CLI never prints or logs tokens or keys.
