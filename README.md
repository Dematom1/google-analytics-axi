# google-analytics-axi

[![CI](https://github.com/Dematom1/google-analytics-axi/actions/workflows/ci.yml/badge.svg)](https://github.com/Dematom1/google-analytics-axi/actions/workflows/ci.yml) [![Platform: Linux and macOS](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-blue)](#)

Read-only Google Analytics 4 and Search Console for agents. `google-analytics-axi` is an [AXI](https://github.com/kunchenguid/axi) CLI. Output uses compact [TOON](https://toonformat.dev/) format. This initial scaffold makes no Google API calls and is not published.

```sh
npm install
npm run build
node dist/bin/google-analytics-axi.js --help
```

The GA4 and Search Console commands, authentication, hooks, and setup lifecycle will arrive in follow-up work. No credentials are read or stored by this scaffold.
