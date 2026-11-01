import { Entry } from "@napi-rs/keyring";
import { createServer } from "node:http";
import { readFileSync, unlinkSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

const SERVICE = "google-analytics-axi";
const ACCOUNT = "google-oauth-refresh-token";
const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
];
const configDir = () =>
  process.env["XDG_CONFIG_HOME"]
    ? join(process.env["XDG_CONFIG_HOME"], "google-analytics-axi")
    : join(homedir(), ".config", "google-analytics-axi");
const configFile = () => join(configDir(), "config.json");
const fail = (message: string): never => {
  throw new Error(message);
};

export type Keychain = { getPassword(): string | null; setPassword(value: string): void; deletePassword(): boolean };
export type OAuthOptions = {
  clientId: string;
  clientSecret: string;
  keychain: Keychain;
  openBrowser?: (url: string) => void;
  authorizeEndpoint?: string;
  tokenEndpoint?: string;
};

function systemKeychain(): Keychain {
  try {
    return new Entry(SERVICE, ACCOUNT);
  } catch {
    return fail("OS keychain is unavailable; install and unlock Secret Service (Linux) or use macOS Keychain");
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : "xdg-open";
  const child = spawn(command, [url], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

function saveConfig(config: { serviceAccountPath?: string; authType?: string }): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configFile(), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}
function readConfig(): { serviceAccountPath?: string; authType?: string } {
  try {
    const data: unknown = JSON.parse(readFileSync(configFile(), "utf8"));
    if (data && typeof data === "object") {
      const config: { serviceAccountPath?: string; authType?: string } = {};
      if ("serviceAccountPath" in data && typeof data.serviceAccountPath === "string")
        config.serviceAccountPath = data.serviceAccountPath;
      if ("authType" in data && typeof data.authType === "string") config.authType = data.authType;
      return config;
    }
  } catch {
    /* No configured credential. */
  }
  return {};
}

export async function runOAuthSetup(options: OAuthOptions): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not open the local OAuth callback");
  const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
  const state = randomBytes(24).toString("hex");
  const authUrl = new URL(
    options.authorizeEndpoint ?? "https://accounts.google.com/o/oauth2/v2/auth",
  );
  authUrl.search = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  }).toString();
  const callback = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Google OAuth timed out")), 180_000);
    server.on("request", (request, response) => {
      const url = new URL(request.url ?? "/", redirectUri);
      if (url.pathname !== "/oauth2callback") {
        response.writeHead(404).end();
        return;
      }
      const got = Buffer.from(url.searchParams.get("state") ?? "");
      const expected = Buffer.from(state);
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        response.writeHead(400).end("OAuth state mismatch");
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      response
        .writeHead(code ? 200 : 400, { "content-type": "text/plain" })
        .end(code ? "Authentication complete. You may close this window." : "Authentication was not completed.");
      clearTimeout(timer);
      if (code) resolve(code);
      else reject(new Error(error ? "Google OAuth was denied" : "Google did not return an authorization code"));
    });
  });
  try {
    (options.openBrowser ?? openBrowser)(authUrl.toString());
    const code = await callback;
    const tokenResponse = await fetch(
      options.tokenEndpoint ?? "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: options.clientId,
          client_secret: options.clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      },
    );
    if (!tokenResponse.ok) throw new Error("Google token exchange failed; check the OAuth client configuration");
    const data: unknown = await tokenResponse.json();
    if (
      !data ||
      typeof data !== "object" ||
      !("refresh_token" in data) ||
      typeof data.refresh_token !== "string" ||
      !data.refresh_token.trim()
    )
      throw new Error("Google did not return a refresh token; retry setup and approve offline access");
    try {
      options.keychain.setPassword(data.refresh_token);
    } catch {
      throw new Error(
        "Could not store the Google refresh token in the OS keychain; check that the keychain is available and unlocked",
      );
    }
    saveConfig({ authType: "oauth" });
  } finally {
    server.close();
  }
}

export async function setupCommand(args: string[]): Promise<string> {
  const [first] = args;
  if (first === "--help" || first === "-h")
    return "usage: google-analytics-axi setup [--client-id <id> --client-secret <secret>] | service-account <key.json> | status | uninstall\nOAuth client credentials can also be set with GOOGLE_ANALYTICS_AXI_CLIENT_ID and GOOGLE_ANALYTICS_AXI_CLIENT_SECRET.\n";
  const action = first && !first.startsWith("-") ? first : "oauth";
  const rest = action === "oauth" ? args : args.slice(1);
  if (action === "status") {
    if (rest.length) fail("usage: google-analytics-axi setup status");
    const config = readConfig();
    let stored = false;
    if (config.authType === "oauth") {
      try {
        stored = Boolean(systemKeychain().getPassword());
      } catch {
        throw new Error("OS keychain is unavailable; install and unlock Secret Service (Linux) or use macOS Keychain");
      }
    }
    const serviceAccount =
      config.authType === "service-account" &&
      Boolean(config.serviceAccountPath && existsSync(config.serviceAccountPath));
    return `auth:\n  status: ${stored || serviceAccount ? "configured" : "not configured"}\n  method: ${stored ? "oauth" : serviceAccount ? "service-account" : "none"}\n`;
  }
  if (action === "uninstall") {
    if (rest.length) fail("usage: google-analytics-axi setup uninstall");
    if (readConfig().authType === "oauth") systemKeychain().deletePassword();
    try {
      unlinkSync(configFile());
    } catch {
      /* Already absent. */
    }
    return "auth:\n  status: removed\n";
  }
  if (action === "service-account") {
    if (rest.length !== 1) fail("usage: google-analytics-axi setup service-account <key.json>");
    const path = rest[0];
    if (!path) throw new Error("service-account key path is required");
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      fail("service-account key file is unreadable or invalid JSON");
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("type" in parsed) ||
      parsed.type !== "service_account" ||
      !("client_email" in parsed) ||
      typeof parsed.client_email !== "string" ||
      !parsed.client_email.trim() ||
      !("private_key" in parsed) ||
      typeof parsed.private_key !== "string" ||
      !parsed.private_key.trim()
    )
      fail("file is not a valid Google service-account key");
    saveConfig({ authType: "service-account", serviceAccountPath: resolve(path) });
    return "auth:\n  status: configured\n  method: service-account\n";
  }
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  while (rest.length) {
    const flag = rest.shift();
    if (flag === "--client-id") clientId = rest.shift();
    else if (flag === "--client-secret") clientSecret = rest.shift();
    else fail(`unknown setup option '${flag}'`);
  }
  clientId ??= process.env["GOOGLE_ANALYTICS_AXI_CLIENT_ID"];
  clientSecret ??= process.env["GOOGLE_ANALYTICS_AXI_CLIENT_SECRET"];
  if (!clientId || !clientSecret)
    throw new Error(
      "provide --client-id and --client-secret or set GOOGLE_ANALYTICS_AXI_CLIENT_ID and GOOGLE_ANALYTICS_AXI_CLIENT_SECRET",
    );
  const keychain = systemKeychain();
  await runOAuthSetup({ clientId, clientSecret, keychain });
  return "auth:\n  status: configured\n  method: oauth\n  stored: OS keychain\n";
}
