---
name: google-analytics-axi
description: Read-only Google Analytics 4 and Search Console data for agents.
---

# google-analytics-axi

Use `google-analytics-axi` for read-only Google Analytics 4 and Search Console reporting. Output is compact TOON. See the [README](../../README.md#authentication) for full authentication setup.

## Authentication

Prefer a service account for agents and CI:

1. Create or reuse a dedicated Google Cloud project.
2. Enable the Google Analytics Data API, Google Analytics Admin API, and Google Search Console API.
3. Create a service account with no project-level IAM roles and create a JSON key.
4. Load the key JSON from a secret manager into `GOOGLE_ANALYTICS_AXI_SA_KEY`; never commit the key.
5. Grant the service-account email Viewer in GA4 at **Admin > Property access management > + > Add users** (untick notify).
6. Grant it Restricted in Search Console at **Settings > Users and permissions > Add user**.

`GOOGLE_ANALYTICS_AXI_SA_KEY` takes precedence over `GOOGLE_APPLICATION_CREDENTIALS`, which takes precedence over user ADC. Run `google-analytics-axi setup` for a numbered setup guide and access checks. Run `google-analytics-axi setup check [--property <id>]` to list accessible properties and sites and get a seven-day sessions/active-users total.

For personal ADC, use your own Desktop OAuth client and run `gcloud auth application-default login --client-id-file=client.json --scopes=https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform`. Google's built-in `gcloud` client is blocked for these scopes. Do not create an OAuth client in a project whose consent screen serves another app. If deleting a temporary key file after use, chain the commands with `&&`, not `&`.
