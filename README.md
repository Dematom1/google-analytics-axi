# search-console-axi

[![CI](https://github.com/Dematom1/search-console-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/Dematom1/search-console-axi/actions/workflows/ci.yml) [![Platform: Linux and macOS](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue)](#)

Read-only Google Search Console reporting and URL inspection for agents. `search-console-axi` is an [AXI](https://github.com/kunchenguid/axi) CLI. Output uses compact [TOON](https://toonformat.dev/) format. Requires Node.js 22.12 or newer.

```sh
npm install
npm run build
node dist/bin/search-console-axi.js --help
```

## Authentication

The CLI reads credentials through `google-auth-library`. It never stores or prints OAuth tokens or service-account keys. For personal access, create your own Desktop OAuth client and configure ADC with `gcloud auth application-default login --client-id-file=client.json --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform`. Google's built-in `gcloud` OAuth client cannot grant the Search Console scope.

### Service account

1. Create or reuse a Google Cloud project and enable the Google Search Console API.
2. Create a service account; it needs no project-level IAM roles.
3. Load its JSON key from your secret manager into `SEARCH_CONSOLE_AXI_SA_KEY`. Never commit the key.
4. In Search Console, add the service-account email under **Settings > Users and permissions** with Restricted access.

For local key files, set `GOOGLE_APPLICATION_CREDENTIALS` or run `search-console-axi setup service-account <key.json>`. `SEARCH_CONSOLE_AXI_SA_KEY` takes precedence over `GOOGLE_APPLICATION_CREDENTIALS`, which takes precedence over user ADC. Set the ADC quota project with `gcloud auth application-default set-quota-project <project>` or use `GOOGLE_CLOUD_QUOTA_PROJECT`.

Run `search-console-axi setup` to check credentials and accessible sites. `search-console-axi setup status` reports the credential type and available account email, never credential contents. `search-console-axi setup uninstall` removes only the CLI's local configuration.

## Read Search Console

Run `search-console-axi` for the default site's last seven complete days of clicks, impressions, CTR, position, top queries and pages, and low-CTR opportunities. Use `search-console-axi inspect <url> --site <site-url>` to inspect indexing for a URL. Reporting and inspection do not modify Search Console data; setup may write or remove local configuration.
