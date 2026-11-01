import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createServer } from "node:http";
import { runOAuthSetup } from "../dist/bin/auth.js";

const cli = new URL("../dist/bin/google-analytics-axi.js", import.meta.url);
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const run = (...args) => execFileSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8" });

test("CLI exposes SDK help, setup help, version, and a no-argument home", () => {
  assert.match(run("--help"), /Usage:/);
  assert.match(run("--help"), /setup/);
  assert.match(run("setup", "--help"), /service-account/);
  assert.match(run("--help"), /update/);
  assert.equal(run("--version").trim(), version);
  assert.match(run(), /status: scaffold/);
  assert.throws(
    () => run("setup", "--client-id", "test-client"),
    (error) => error.stdout.toString().includes("provide --client-id and --client-secret"),
  );
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
  const tokenServer = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.match(body, /grant_type=authorization_code/);
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ access_token: "never-print-access-token", refresh_token: "refresh-secret" }));
  });
  await new Promise((resolve) => tokenServer.listen(0, "127.0.0.1", resolve));
  const address = tokenServer.address();
  assert.ok(address && typeof address !== "string");
  try {
    await runOAuthSetup({
      clientId: "client-id",
      clientSecret: "client-secret",
      keychain,
      tokenEndpoint: `http://127.0.0.1:${address.port}/token`,
      authorizeEndpoint: "http://accounts.test/auth",
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
    tokenServer.close();
  }
});
