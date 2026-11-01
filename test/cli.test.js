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
  let reportProperty;
  const output = decode(
    await setupCommand(["check"], {
      setupCheck: {
        request: async (_auth, url) => {
          urls.push(url);
          if (url.includes("accountSummaries"))
            return {
              accountSummaries: [{ propertySummaries: [{ property: "properties/123", displayName: "Main site" }] }],
            };
          return { siteEntry: [{ siteUrl: "https://example.com/", permissionLevel: "siteRestrictedUser" }] };
        },
        runReport: async (_auth, propertyId) => {
          reportProperty = propertyId;
          return { rows: [{ metricValues: [{ value: "42" }, { value: "17" }] }] };
        },
      },
    }),
  );
  assert.deepEqual(output.ga4_properties, [{ property_id: "123", display_name: "Main site" }]);
  assert.deepEqual(output.search_console_sites, [
    { site_url: "https://example.com/", permission: "siteRestrictedUser" },
  ]);
  assert.deepEqual(output.report, {
    status: "ok",
    property_id: "123",
    date_range: "last 7 days",
    totals: { sessions: "42", active_users: "17" },
  });
  assert.equal(reportProperty, "123");
  assert.equal(urls.length, 2);
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
    await setupCommand(["setup"], {
      setupCheck: {
        request: async (_auth, url) => {
          if (url.includes("accountSummaries"))
            throw {
              response: {
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
            };
          return { siteEntry: [] };
        },
        runReport: async () => {
          throw new Error("must skip report when no property is accessible");
        },
      },
    }),
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
    await setupCommand(["check"], {
      setupCheck: {
        request: async (_auth, url) => {
          if (url.includes("accountSummaries"))
            return { accountSummaries: [{ propertySummaries: [{ property: "properties/123" }] }] };
          throw {
            response: {
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
          };
        },
        runReport: async () => ({ rows: [] }),
      },
    }),
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
    await setupCommand(["check"], {
      setupCheck: {
        request: async () => ({ accountSummaries: [], siteEntry: [] }),
      },
    }),
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
});

test("setup check reports a disabled Google Analytics Data API", async (t) => {
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
    await setupCommand(["check", "--property", "123"], {
      setupCheck: {
        request: async (_auth, url) =>
          url.includes("accountSummaries")
            ? { accountSummaries: [{ propertySummaries: [{ property: "properties/123", displayName: "Main site" }] }] }
            : { siteEntry: [{ siteUrl: "https://example.com/", permissionLevel: "siteRestrictedUser" }] },
        runReport: async () => {
          throw {
            response: {
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
          };
        },
      },
    }),
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
