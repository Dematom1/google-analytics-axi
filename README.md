# google-analytics-axi

[![CI](https://github.com/Dematom1/google-analytics-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/Dematom1/google-analytics-axi/actions/workflows/ci.yml) [![Platform: Linux and macOS](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue)](#)

Read-only Google Analytics 4 and Search Console for agents. `google-analytics-axi` is an [AXI](https://github.com/kunchenguid/axi) CLI. Output uses compact [TOON](https://toonformat.dev/) format.

```sh
npm install
npm run build
node dist/bin/google-analytics-axi.js --help
```

## Authentication

Run `google-analytics-axi setup` to authorize in a browser with Google OAuth. Create an OAuth client ID and secret for a Desktop app in Google Cloud Console, then provide them as `--client-id` and `--client-secret` or set `GOOGLE_ANALYTICS_AXI_CLIENT_ID` and `GOOGLE_ANALYTICS_AXI_CLIENT_SECRET`. The CLI requests only the Analytics read-only and Search Console read-only scopes and stores the refresh token in macOS Keychain or Linux Secret Service. No client secret belongs in this repository.

Run `google-analytics-axi setup service-account <key.json>` to select a service-account key file instead. Grant that service account read-only access to the relevant Analytics property and Search Console property. The CLI stores only the file path in its configuration.

`google-analytics-axi setup status` reports the configured authentication method. `google-analytics-axi setup uninstall` removes the stored refresh token and local configuration. Neither command prints credentials.
