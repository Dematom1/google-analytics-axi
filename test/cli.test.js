import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decode } from "@toon-format/toon";
import { JWT, UserRefreshClient } from "google-auth-library";
import { getAuthClient, setupCommand } from "../dist/bin/auth.js";

const cli = new URL("../dist/bin/google-analytics-axi.js", import.meta.url);
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const scopes = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
];
const run = (args, env = {}) =>
  execFileSync(process.execPath, [cli.pathname, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "gaaxi-auth-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const setEnv = (t, name, value) => {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
};
const factoryFor = (credential, seen) => (options) => {
  seen.push(options);
  return {
    getApplicationDefault: async () => ({ credential, projectId: null }),
    getClient: async () => credential,
  };
};

test("CLI reports its version and structured no-argument home", () => {
  assert.equal(run(["--version"]).trim(), version);
  const home = decode(run([]));
  assert.equal(home.tool, "google-analytics-axi");
  assert.equal(home.status, "scaffold");
  assert.ok(Array.isArray(home.help));
});

test("ADC provider configures authorized-user scopes and quota project headers", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  const client = new UserRefreshClient();
  client.setCredentials({ access_token: "test-access-token" });
  const seen = [];
  const auth = await getAuthClient({ quotaProject: "billing-project", authFactory: factoryFor(client, seen) });
  assert.equal(auth.type, "authorized_user");
  assert.equal(auth.quotaProjectId, "billing-project");
  assert.deepEqual(seen[0].scopes, scopes);
  const headers = await auth.client.getRequestHeaders("https://analyticsdata.googleapis.com");
  assert.equal(headers.get("x-goog-user-project"), "billing-project");
  assert.equal(headers.get("authorization"), "Bearer test-access-token");
});

test("service-account path loads a client with only read-only scopes", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  const path = join(dir, "service-account.json");
  writeFileSync(
    path,
    JSON.stringify({
      type: "service_account",
      client_email: "analytics-agent@example.invalid",
      private_key: "test-key-not-used-for-network",
    }),
  );
  const configured = decode(await setupCommand(["service-account", path]));
  assert.equal(configured.auth.type, "service_account");
  assert.equal(configured.auth.account_email, "analytics-agent@example.invalid");
  const auth = await getAuthClient();
  assert.equal(auth.type, "service_account");
  assert.equal(auth.email, "analytics-agent@example.invalid");
  assert.ok(auth.client instanceof JWT);
  assert.equal(auth.client.email, "analytics-agent@example.invalid");
  assert.deepEqual(auth.client.scopes, scopes);
  const status = decode(run(["setup", "status"], { XDG_CONFIG_HOME: dir }));
  assert.equal(status.auth.type, "service_account");
  assert.equal(status.auth.account_email, "analytics-agent@example.invalid");
  assert.equal(JSON.stringify(status).includes("private_key"), false);
  assert.equal(JSON.stringify(configured).includes("private_key"), false);
});

test("service-account JSON environment variable takes precedence without persisting the key", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", undefined);
  setEnv(
    t,
    "GOOGLE_ANALYTICS_AXI_SA_KEY",
    JSON.stringify({
      type: "service_account",
      client_email: "runtime-agent@example.invalid",
      private_key: "runtime-secret-key",
    }),
  );
  const auth = await getAuthClient();
  assert.equal(auth.source, "GOOGLE_ANALYTICS_AXI_SA_KEY");
  assert.equal(auth.email, "runtime-agent@example.invalid");
  assert.ok(auth.client instanceof JWT);
  assert.equal(JSON.stringify(decode(await setupCommand(["status"]))).includes("runtime-secret-key"), false);
  assert.equal(existsSync(join(dir, "google-analytics-axi", "config.json")), false);
});

test("status explains both ADC setup paths when credentials are missing", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", undefined);
  const output = decode(
    await setupCommand([], {
      authFactory: () => ({
        getApplicationDefault: async () => {
          throw new Error("Could not load the default credentials");
        },
      }),
    }),
  );
  assert.deepEqual(output.auth, { status: "not configured", type: "none" });
  assert.ok(output.setup.some((line) => line.includes("--client-id-file=client.json")));
  assert.ok(output.setup.some((line) => line.includes("GOOGLE_APPLICATION_CREDENTIALS")));
  assert.ok(output.setup.some((line) => line.includes("Google Search Console API")));
});

test("bare setup reports missing credentials rather than treating setup as an argument", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", undefined);
  const output = decode(
    await setupCommand([], {
      authFactory: () => ({
        getApplicationDefault: async () => {
          throw new Error("Could not load the default credentials");
        },
      }),
    }),
  );
  assert.deepEqual(output.auth, { status: "not configured", type: "none" });
});

test("invalid service-account inputs fail at their named source without ADC fallback", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  const seen = [];
  const authFactory = factoryFor(new UserRefreshClient(), seen);
  setEnv(t, "GOOGLE_ANALYTICS_AXI_SA_KEY", "{}");
  await assert.rejects(getAuthClient({ authFactory }), /GOOGLE_ANALYTICS_AXI_SA_KEY/);
  assert.equal(seen.length, 0);
  setEnv(t, "GOOGLE_ANALYTICS_AXI_SA_KEY", undefined);
  const path = join(dir, "not-a-service-account.json");
  writeFileSync(path, "{}");
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", path);
  await assert.rejects(getAuthClient({ authFactory }), /GOOGLE_APPLICATION_CREDENTIALS/);
  assert.equal(seen.length, 0);
});

test("empty credentials path is invalid and never falls back to ADC", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_ANALYTICS_AXI_SA_KEY", undefined);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", "");
  const seen = [];
  await assert.rejects(getAuthClient({ authFactory: factoryFor(new UserRefreshClient(), seen) }), /GOOGLE_APPLICATION_CREDENTIALS/);
  assert.equal(seen.length, 0);
  const status = decode(await setupCommand(["status"]));
  assert.equal(status.auth.status, "invalid");
  assert.match(status.auth.error, /GOOGLE_APPLICATION_CREDENTIALS/);
});

test("uninstall distinguishes absent config from removal failures", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  assert.deepEqual(decode(await setupCommand(["uninstall"])).auth, {
    status: "not configured",
    config: "already absent",
  });
  mkdirSync(join(dir, "google-analytics-axi", "config.json"), { recursive: true });
  await assert.rejects(setupCommand(["uninstall"]));
});

test("unreadable service-account key fails without printing key data", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_ANALYTICS_AXI_SA_KEY", undefined);
  const missing = join(dir, "missing.json");
  await assert.rejects(
    getAuthClient({
      authFactory: () => ({
        getApplicationDefault: async () => {
          throw new Error("Could not load the default credentials");
        },
      }),
    }),
    /Google Application Default Credentials/,
  );
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", missing);
  await assert.rejects(getAuthClient(), /GOOGLE_APPLICATION_CREDENTIALS is unreadable or contains invalid JSON/);
});
