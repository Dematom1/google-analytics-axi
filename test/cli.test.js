import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { test } from "node:test";
import { runOAuthSetup } from "../dist/bin/auth.js";

const cli = new URL("../dist/bin/google-analytics-axi.js", import.meta.url);
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const run = (...args) => execFileSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8" });

test("CLI reports its version and rejects incomplete OAuth credentials", () => {
  assert.equal(run("--version").trim(), version);
  assert.throws(() => run("setup", "--client-id", "test-client"), (error) => error.status === 1);
});

test("OAuth uses read-only scopes, validates the loopback callback, and stores only the refresh token", async () => {
  const keychain = {
    token: undefined,
    getPassword() {
      return this.token;
    },
    setPassword(value) {
      this.token = value;
    },
    deletePassword() {
      this.token = undefined;
      return true;
    },
  };
  let requestedScopes = "";
  const configHome = new URL("../.test-config/", import.meta.url);
  mkdirSync(configHome, { recursive: true });
  const previousConfigHome = process.env.XDG_CONFIG_HOME;
  const originalFetch = globalThis.fetch;
  process.env.XDG_CONFIG_HOME = configHome.pathname;
  globalThis.fetch = async (input, init) => {
    if (String(input) === "https://oauth2.googleapis.com/token") {
      assert.match(String(init.body), /grant_type=authorization_code/);
      return new Response(JSON.stringify({ access_token: "never-print-access-token", refresh_token: "refresh-secret" }), {
        headers: { "content-type": "application/json" },
      });
    }
    return originalFetch(input, init);
  };
  try {
    await runOAuthSetup({
      clientId: "client-id",
      clientSecret: "client-secret",
      keychain,
      openBrowser: async (value) => {
        const auth = new URL(value);
        requestedScopes = auth.searchParams.get("scope");
        const redirect = new URL(auth.searchParams.get("redirect_uri"));
        redirect.searchParams.set("code", "authorization-code");
        redirect.searchParams.set("state", "wrong-state");
        const mismatch = await fetch(redirect);
        assert.equal(mismatch.status, 400);
        redirect.searchParams.set("state", auth.searchParams.get("state"));
        const callback = await fetch(redirect);
        assert.equal(callback.status, 200);
      },
    });
    assert.deepEqual(requestedScopes.split(" "), [
      "https://www.googleapis.com/auth/analytics.readonly",
      "https://www.googleapis.com/auth/webmasters.readonly",
    ]);
    assert.equal(keychain.getPassword(), "refresh-secret");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previousConfigHome;
    rmSync(configHome, { recursive: true, force: true });
  }
});
