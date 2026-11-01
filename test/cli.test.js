import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { decode } from "@toon-format/toon";
import { JWT, UserRefreshClient } from "google-auth-library";
import { getAuthClient, setupCommand } from "../dist/bin/auth.js";
import { runHome, inspectUrl } from "../dist/bin/setup-check.js";

const cli = new URL("../dist/bin/search-console-axi.js", import.meta.url);
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const scopes = ["https://www.googleapis.com/auth/webmasters.readonly"];
const run = (args, env = {}) =>
  execFileSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "search-console-axi-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const setEnv = (t, name, value) => {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  t.after(() => (previous === undefined ? delete process.env[name] : (process.env[name] = previous)));
};
const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const key = JSON.stringify({
  type: "service_account",
  client_email: "sc-agent@example.invalid",
  private_key: privateKey,
});
const mockAuth = (request) => ({
  type: "service_account",
  source: "SEARCH_CONSOLE_AXI_SA_KEY",
  email: "sc-agent@example.invalid",
  client: { request },
});

test("CLI reports its version and live home without credentials", () => {
  assert.equal(run(["--version"]).trim(), version);
  const home = decode(run([], { SEARCH_CONSOLE_AXI_SA_KEY: "{}", GOOGLE_APPLICATION_CREDENTIALS: "" }));
  assert.equal(home.auth.status, "invalid");
  assert.equal(home.setup.guide.length > 0, true);
});

test("ADC requests only the Search Console read-only scope", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  const client = new UserRefreshClient();
  client.setCredentials({ access_token: "test-access-token" });
  let options;
  const auth = await getAuthClient({
    authFactory: (opts) => {
      options = opts;
      return { getApplicationDefault: async () => ({ credential: client, projectId: null }) };
    },
  });
  assert.equal(auth.type, "authorized_user");
  assert.deepEqual(options.scopes, scopes);
});

test("service-account JSON env takes precedence without persisting or printing its key", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  setEnv(t, "GOOGLE_APPLICATION_CREDENTIALS", undefined);
  setEnv(t, "SEARCH_CONSOLE_AXI_SA_KEY", key);
  const auth = await getAuthClient();
  assert.ok(auth.client instanceof JWT);
  assert.equal(auth.source, "SEARCH_CONSOLE_AXI_SA_KEY");
  const status = decode(await setupCommand(["status"]));
  assert.equal(status.auth.account_email, "sc-agent@example.invalid");
  assert.equal(JSON.stringify(status).includes("private_key"), false);
  assert.equal(existsSync(join(dir, "search-console-axi", "config.json")), false);
});

test("setup check is ready with Search Console access alone", async () => {
  const credential = new UserRefreshClient();
  credential.request = async ({ url }) => {
    assert.equal(url, "https://searchconsole.googleapis.com/webmasters/v3/sites");
    return { data: { siteEntry: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser" }] } };
  };
  const output = decode(
    await setupCommand(["check"], {
      authFactory: () => ({ getApplicationDefault: async () => ({ credential, projectId: null }) }),
    }),
  );
  assert.equal(output.setup.status, "ready");
  assert.deepEqual(output.sites, [{ site_url: "sc-domain:example.com", permission: "siteRestrictedUser" }]);
});

test("empty Search Console site lists explain no resources may exist", async () => {
  const auth = mockAuth(async () => ({ data: { siteEntry: [] } }));
  const expected = "No Search Console sites visible to this account - grant access as in step 4, or none exist.";
  const home = decode(await runHome(auth));
  assert.equal(home.sites, expected);

  const credential = new UserRefreshClient();
  credential.request = async () => ({ data: { siteEntry: [] } });
  const check = decode(
    await setupCommand(["check"], {
      authFactory: () => ({ getApplicationDefault: async () => ({ credential, projectId: null }) }),
    }),
  );
  assert.equal(check.setup.missing[0], expected);
});

test("home reports Search Console queries, pages, and low-CTR opportunities", async () => {
  const calls = [];
  const auth = mockAuth(async (request) => {
    calls.push(request);
    if (request.url.endsWith("/sites")) return { data: { siteEntry: [{ siteUrl: "sc-domain:example.com" }] } };
    if (request.url.includes("searchAnalytics/query"))
      return {
        data: { rows: [{ keys: ["https://example.com/page"], clicks: 4, impressions: 500, ctr: 0.008, position: 3 }] },
      };
    throw new Error("Unexpected request");
  });
  const output = decode(await runHome(auth));
  assert.equal(output.tool, "search-console-axi");
  assert.equal(output.site, "sc-domain:example.com");
  assert.equal(output.top_queries.length, 1);
  assert.equal(output.top_pages.length, 1);
  assert.equal(output.low_ctr_opportunities.length, 1);
  assert.equal(calls.length, 5);
  const reports = calls.filter((call) => call.url.includes("searchAnalytics/query"));
  const dates = reports.map(({ data }) => [data.startDate, data.endDate]);
  const orderedQueries = reports.filter(({ data }) => data.orderBy);
  assert.deepEqual(
    orderedQueries.map(({ data }) => [data.orderBy[0].field, data.orderBy[0].direction]).sort(),
    [["clicks", "descending"], ["clicks", "descending"], ["impressions", "descending"]].sort(),
  );
  assert.equal(dates.length, 4);
  assert.ok(dates.every(([start, end]) => /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)));
  assert.ok(dates.every(([start, end]) => start === dates[0][0] && end === dates[0][1]));
  assert.equal(Date.parse(`${dates[0][1]}T00:00:00Z`) - Date.parse(`${dates[0][0]}T00:00:00Z`), 6 * 86_400_000);
  const pacificToday = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date())
      .map(({ type, value }) => [type, value]),
  );
  const yesterday = new Date(
    Date.UTC(Number(pacificToday.year), Number(pacificToday.month) - 1, Number(pacificToday.day)) - 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  assert.equal(dates[0][1], yesterday);
});

test("URL inspection uses the read-only index inspection endpoint", async () => {
  let seen;
  const output = decode(
    await inspectUrl(
      mockAuth(async (request) => {
        seen = request;
        return { data: { inspectionResult: { indexStatusResult: { verdict: "PASS" } } } };
      }),
      "https://example.com/page",
      "sc-domain:example.com",
    ),
  );
  assert.equal(seen.url, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");
  assert.deepEqual(seen.data, {
    inspectionUrl: "https://example.com/page",
    siteUrl: "sc-domain:example.com",
    languageCode: "en-US",
  });
  assert.equal(output.indexStatusResult.verdict, "PASS");
});

test("uninstall is idempotent and removes only local config", async (t) => {
  const dir = temp(t);
  setEnv(t, "XDG_CONFIG_HOME", dir);
  assert.deepEqual(decode(await setupCommand(["uninstall"])).auth, {
    status: "not configured",
    config: "already absent",
  });
  const config = join(dir, "search-console-axi", "config.json");
  const fs = await import("node:fs");
  fs.mkdirSync(join(dir, "search-console-axi"), { recursive: true });
  writeFileSync(config, "{}\n");
  assert.deepEqual(decode(await setupCommand(["uninstall"])).auth, { status: "removed", config: "removed" });
  assert.equal(existsSync(config), false);
});
