# google-analytics-axi

[![CI](https://github.com/Dematom1/google-analytics-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/Dematom1/google-analytics-axi/actions/workflows/ci.yml) [![Platform: Linux and macOS](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue)](#)

Read-only Google Analytics 4 and Search Console for agents. `google-analytics-axi` is an [AXI](https://github.com/kunchenguid/axi) CLI. Output uses compact [TOON](https://toonformat.dev/) format.

```sh
npm install
npm run build
node dist/bin/google-analytics-axi.js --help
```

## Authentication

The CLI reads credentials through `google-auth-library`. It does not store OAuth tokens or service-account keys. The Google built-in OAuth client cannot grant these sensitive scopes, so user sign-in requires your own Desktop OAuth client.

### Set up a service account (recommended)

1. Create a service account in a dedicated Google Cloud project.
2. Enable the Google Analytics Data API, Google Analytics Admin API, and Google Search Console API in that project.
3. Create a JSON key. Add the service account as Viewer on the GA4 property and as a user in Search Console. Restricted access is enough.
4. Supply the key at runtime as `GOOGLE_ANALYTICS_AXI_SA_KEY` (JSON string), or set `GOOGLE_APPLICATION_CREDENTIALS` to its path. You can also register a local path with `google-analytics-axi setup service-account <key.json>`.

For example, inject the key without writing it to disk:

```sh
av inject +GOOGLE_ANALYTICS_AXI_SA_KEY -- google-analytics-axi setup status
```

The environment variable takes precedence over the file path. Keys are parsed in memory and never copied, printed, or logged.

### Set up personal ADC

1. Create one Google Cloud project. Enable the Google Analytics Data API, Google Analytics Admin API, and Google Search Console API in the quota project.
2. Configure the OAuth consent screen as External, add yourself as a test user, and add the Analytics and Search Console read-only scopes.
3. Create a Desktop OAuth client and download its JSON file as `client.json`.
4. Run `gcloud auth application-default login --client-id-file=client.json --scopes=https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform`.
5. Set the quota project with `gcloud auth application-default set-quota-project <project>`.

Run `google-analytics-axi setup` to detect credentials and show setup instructions. Run `google-analytics-axi setup status` to inspect the ADC type, available account email, and quota project. Set a quota-project override with `GOOGLE_CLOUD_QUOTA_PROJECT` or `google-analytics-axi setup --quota-project <project>`. The CLI sends the selected project in `x-goog-user-project`.

Run `google-analytics-axi setup uninstall` to remove the CLI's local configuration. It does not delete ADC files or service-account key files.
