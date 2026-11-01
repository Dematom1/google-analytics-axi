import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
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
const setupOptions = (t, { accountSummaries = [], sites = [], adminError, sitesError, report, reportError, requests = [] }) => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env["GOOGLE_ANALYTICS_AXI_SA_KEY"];
  const key = JSON.parse(previousKey);
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  process.env["GOOGLE_ANALYTICS_AXI_SA_KEY"] = JSON.stringify({ ...key, private_key: privateKey });
  globalThis.fetch = async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("oauth2.googleapis.com/token"))
      return new Response(JSON.stringify({ access_token: "test-access-token", expires_in: 3600 }), {
        headers: { "content-type": "application/json" },
      });
    requests.push(url);
    const reportRequest = url.includes("analyticsdata.googleapis.com");
    const adminRequest = url.startsWith("https://analyticsadmin.googleapis.com/v1beta/accountSummaries");
    const searchConsoleRequest = url.startsWith("https://searchconsole.googleapis.com/webmasters/v3/sites");
    if (!reportRequest && !adminRequest && !searchConsoleRequest) throw new Error(`Unexpected Google request: ${url}`);
    const failure = reportRequest ? reportError : adminRequest ? adminError : sitesError;
    if (failure)
      return new Response(JSON.stringify(failure.data), {
        status: failure.status,
        headers: { "content-type": "application/json" },
      });
    const data = reportRequest ? (report ?? { rows: [] }) : adminRequest ? { accountSummaries } : { siteEntry: sites };
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
  };
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env["GOOGLE_ANALYTICS_AXI_SA_KEY"];
    else process.env["GOOGLE_ANALYTICS_AXI_SA_KEY"] = previousKey;
  });
  return {};
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
  assert.equal(output.auth.status, "not configured");
  assert.ok(output.setup.guide.some((step) => step.instruction.includes("--client-id-file=client.json")));
  assert.ok(output.setup.guide.some((step) => step.instruction.includes("GOOGLE_ANALYTICS_AXI_SA_KEY")));
  assert.ok(output.setup.guide.some((step) => step.instruction.includes("Google Search Console API")));
  assert.match(output.setup.missing[0], /No service-account key or user ADC/);
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
  assert.equal(output.auth.status, "not configured");
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
  await assert.rejects(
    getAuthClient({ authFactory: factoryFor(new UserRefreshClient(), seen) }),
    /GOOGLE_APPLICATION_CREDENTIALS/,
  );
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

test("malformed config blocks status and credential replacement", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_ANALYTICS_AXI_SA_KEY", undefined);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", undefined);
  const configDir = join(dir, "google-analytics-axi");
  mkdirSync(configDir, { recursive: true });
  const configPath = join(configDir, "config.json");
  writeFileSync(configPath, "{broken");
  const keyPath = join(dir, "key.json");
  writeFileSync(keyPath, JSON.stringify({
    type: "service_account",
    client_email: "agent@example.invalid",
    private_key: "not-used",
  }));
  await assert.rejects(setupCommand(["status"]), /contains invalid JSON/);
  await assert.rejects(setupCommand(["service-account", keyPath]), /contains invalid JSON/);
  await assert.rejects(
    setupCommand([], { authFactory: () => ({ getApplicationDefault: async () => ({}) }) }),
    /contains invalid JSON/,
  );
  assert.equal(readFileSync(configPath, "utf8"), "{broken");
});

test("setup check reports properties, sites, and a seven-day total report using the env key in memory", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", undefined);
  setEnv(
    t,
    "GOOGLE_ANALYTICS_AXI_SA_KEY",
    JSON.stringify({
      type: "service_account",
      client_email: "check-agent@example.invalid",
      project_id: "prod-project",
      private_key: "not-a-real-key",
    }),
  );
  const urls = [];
  const output = decode(
    await setupCommand(["check"], setupOptions(t, {
      accountSummaries: [{ propertySummaries: [{ property: "properties/123", displayName: "Main site" }] }],
      sites: [{ siteUrl: "https://example.com/", permissionLevel: "siteRestrictedUser" }],
      report: {
        rows: [
          { metricValues: [{ value: "42" }, { value: "17" }] },
          { metricValues: [{ value: "8" }, { value: "3" }] },
        ],
      },
      requests: urls,
    })),
  );
  assert.deepEqual(output.ga4_properties, [{ property_id: "123", display_name: "Main site" }]);
  assert.deepEqual(output.search_console_sites, [
    { site_url: "https://example.com/", permission: "siteRestrictedUser" },
  ]);
  assert.deepEqual(output.report, {
    status: "ok",
    property_id: "123",
    date_range: "last 7 days",
    totals: { sessions: "50", active_users: "20" },
  });
  assert.equal(urls.filter((url) => url.includes("googleapis.com")).length, 3);
  assert.ok(urls.some((url) => url.includes("properties/123:runReport")));
  assert.equal(output.setup.status, "ready");
  assert.equal(JSON.stringify(output).includes("not-a-real-key"), false);
  assert.equal(existsSync(join(dir, "google-analytics-axi", "config.json")), false);
});

test("setup detects missing GA4 and Search Console access and disabled APIs", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", undefined);
  setEnv(
    t,
    "GOOGLE_ANALYTICS_AXI_SA_KEY",
    JSON.stringify({
      type: "service_account",
      client_email: "check-agent@example.invalid",
      project_id: "prod-project",
      private_key: "not-a-real-key",
    }),
  );
  const output = decode(
    await setupCommand(["setup"], setupOptions(t, {
      adminError: {
        status: 403,
        data: {
          error: {
            details: [
              {
                reason: "SERVICE_DISABLED",
                metadata: { service: "analyticsadmin.googleapis.com", consumer: "projects/prod-project" },
              },
            ],
          },
        },
      },
    })),
  );
  assert.equal(output.setup.status, "incomplete");
  assert.ok(
    output.setup.missing.some((item) => item.includes("Google Analytics Admin API") && item.includes("prod-project")),
  );
  assert.ok(
    output.errors.some(
      (error) => error.step === "ga4_properties" && error.message.includes("Google Analytics Admin API"),
    ),
  );
  assert.ok(
    output.setup.missing.some(
      (item) =>
        item.includes("check-agent@example.invalid") &&
        item.includes("Search Console Settings > Users and permissions"),
    ),
  );
  assert.deepEqual(output.report, { status: "skipped" });
});

test("setup names the disabled Search Console API and project", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", undefined);
  setEnv(
    t,
    "GOOGLE_ANALYTICS_AXI_SA_KEY",
    JSON.stringify({
      type: "service_account",
      client_email: "check-agent@example.invalid",
      project_id: "prod-project",
      private_key: "not-a-real-key",
    }),
  );
  const output = decode(
    await setupCommand(["check"], setupOptions(t, {
      accountSummaries: [{ propertySummaries: [{ property: "properties/123" }] }],
      sitesError: {
        status: 403,
        data: {
          error: {
            details: [
              {
                reason: "SERVICE_DISABLED",
                metadata: { service: "searchconsole.googleapis.com", consumer: "projects/prod-project" },
              },
            ],
          },
        },
      },
      report: { rows: [] },
    })),
  );
  assert.ok(
    output.errors.some(
      (error) =>
        error.step === "search_console_sites" &&
        error.message.includes("Google Search Console API") &&
        error.message.includes("prod-project"),
    ),
  );
});

test("setup detects empty GA4 and Search Console access lists", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", undefined);
  setEnv(
    t,
    "GOOGLE_ANALYTICS_AXI_SA_KEY",
    JSON.stringify({
      type: "service_account",
      client_email: "check-agent@example.invalid",
      private_key: "not-a-real-key",
    }),
  );
  const output = decode(
    await setupCommand(["check", "--property", "999"], setupOptions(t, {
        requests: [],
      })),
  );
  assert.ok(
    output.setup.missing.some(
      (item) => item.includes("check-agent@example.invalid") && item.includes("GA4 Admin > Property access management"),
    ),
  );
  assert.ok(
    output.setup.missing.some(
      (item) =>
        item.includes("check-agent@example.invalid") &&
        item.includes("Search Console Settings > Users and permissions"),
    ),
  );
  assert.deepEqual(output.report, { status: "skipped" });
  assert.equal(output.setup.status, "incomplete");
});

test("explicit property must appear in the visible property list", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", undefined);
  setEnv(
    t,
    "GOOGLE_ANALYTICS_AXI_SA_KEY",
    JSON.stringify({ type: "service_account", client_email: "check-agent@example.invalid", private_key: "key" }),
  );
  const urls = [];
  const output = decode(
    await setupCommand(["check", "--property", "999"], setupOptions(t, {
      accountSummaries: [{ propertySummaries: [{ property: "properties/123" }] }],
      sites: [{ siteUrl: "https://example.com/", permissionLevel: "siteRestrictedUser" }],
      requests: urls,
    })),
  );
  assert.equal(output.report.status, "skipped");
  assert.equal(output.setup.status, "incomplete");
  assert.ok(output.setup.missing.some((item) => item.includes("property 999 is not visible")));
  assert.equal(urls.some((url) => url.includes("analyticsdata.googleapis.com")), false);
});

test("setup check identifies legacy disabled API errors", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", undefined);
  setEnv(
    t,
    "GOOGLE_ANALYTICS_AXI_SA_KEY",
    JSON.stringify({ type: "service_account", client_email: "check-agent@example.invalid", private_key: "key" }),
  );
  const output = decode(
    await setupCommand(["check"], setupOptions(t, {
      adminError: {
        status: 403,
        data: { error: { errors: [{ reason: "accessNotConfigured" }], message: "API disabled in project legacy-project" } },
      },
    })),
  );
  assert.ok(
    output.errors.some(
      (error) =>
        error.step === "ga4_properties" &&
        error.message.includes("Google Analytics Admin API") &&
        error.message.includes("legacy-project"),
    ),
  );
});

test("setup check reports a disabled Google Analytics Data API",  async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", undefined);
  setEnv(
    t,
    "GOOGLE_ANALYTICS_AXI_SA_KEY",
    JSON.stringify({
      type: "service_account",
      client_email: "check-agent@example.invalid",
      project_id: "prod-project",
      private_key: "not-a-real-key",
    }),
  );
  const output = decode(
    await setupCommand(["check", "--property", "123"], setupOptions(t, {
      accountSummaries: [{ propertySummaries: [{ property: "properties/123", displayName: "Main site" }] }],
      sites: [{ siteUrl: "https://example.com/", permissionLevel: "siteRestrictedUser" }],
      reportError: {
        status: 403,
        data: {
          error: {
            details: [
              {
                reason: "SERVICE_DISABLED",
                metadata: { service: "analyticsdata.googleapis.com", consumer: "projects/prod-project" },
              },
            ],
          },
        },
      },
    })),
  );
  assert.ok(
    output.errors.some(
      (error) =>
        error.step === "ga4_report" &&
        error.message.includes("Google Analytics Data API") &&
        error.message.includes("prod-project"),
    ),
  );
  assert.equal(output.report.status, "error");
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
