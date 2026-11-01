# google-analytics-axi

[![CI](https://github.com/Dematom1/google-analytics-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/Dematom1/google-analytics-axi/actions/workflows/ci.yml) [![Platform: Linux and macOS](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue)](#)

Read-only Google Analytics 4 and Search Console for agents. `google-analytics-axi` is an [AXI](https://github.com/kunchenguid/axi) CLI. Output uses compact [TOON](https://toonformat.dev/) format. Requires Node.js 22.12 or newer.

```sh
npm install
npm run build
node dist/bin/google-analytics-axi.js --help
```

## Authentication

The CLI reads credentials through `google-auth-library`. It does not store OAuth tokens or service-account keys. The Google built-in OAuth client cannot grant these sensitive scopes, so user sign-in requires your own Desktop OAuth client.

### Set up a service account (recommended)

1. Create or reuse a dedicated Google Cloud project.
2. Enable the Google Analytics Data API, Google Analytics Admin API, and Google Search Console API in that project.
3. Create a service account with no project-level IAM roles, then create a JSON key for it.
4. Store the key in a secret manager and load its JSON into `GOOGLE_ANALYTICS_AXI_SA_KEY`. Never commit the key. For example:

   ```sh
   GOOGLE_ANALYTICS_AXI_SA_KEY="$(<your secret manager command>)" google-analytics-axi setup check
   ```

5. Add the service account email as Viewer in GA4: **Admin > Property access management > + > Add users**. Untick **Notify new users**.
6. Add it as Restricted in Search Console: **Settings > Users and permissions > Add user**.

The service account needs no project-level IAM roles. For local key files, set `GOOGLE_APPLICATION_CREDENTIALS` to the path or run `google-analytics-axi setup service-account <key.json>`. `GOOGLE_ANALYTICS_AXI_SA_KEY` takes precedence over `GOOGLE_APPLICATION_CREDENTIALS`, which takes precedence over user ADC. Keys are parsed in memory and never copied, printed, or logged.

`google-analytics-axi setup` prints this numbered guide and checks for missing API and property access. `google-analytics-axi setup check [--property <id>]` verifies accessible GA4 properties and Search Console sites, then runs a read-only seven-day sessions and active-users total report.

Do not create an OAuth client in a project whose consent screen serves another app. Google's built-in `gcloud` OAuth client is blocked for these scopes. If you temporarily save a key file and then delete it, chain the commands with `&&`, not `&`.

### Set up personal ADC

1. Create or reuse a dedicated Google Cloud project and enable the Google Analytics Data API, Google Analytics Admin API, and Google Search Console API.
2. Configure the OAuth consent screen as External, add yourself as a test user, and add the Analytics and Search Console read-only scopes.
3. Create your own Desktop OAuth client as `client.json`.
4. Run `gcloud auth application-default login --client-id-file=client.json --scopes=https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform`.
5. Set the quota project with `gcloud auth application-default set-quota-project <project>`.

Run `google-analytics-axi setup` to detect credentials and show setup instructions. Run `google-analytics-axi setup status` to inspect the ADC type, available account email, and quota project. Set a quota-project override with `GOOGLE_CLOUD_QUOTA_PROJECT` or `google-analytics-axi setup --quota-project <project>`. The CLI sends the selected project in `x-goog-user-project`.

Run `google-analytics-axi setup uninstall` to remove the CLI's local configuration. It does not delete ADC files or service-account key files.
