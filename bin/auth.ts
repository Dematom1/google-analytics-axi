import { GoogleAuth, JWT, UserRefreshClient, type AuthClient, type GoogleAuthOptions } from "google-auth-library";
import { encode } from "@toon-format/toon";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
];
const NO_ADC_MESSAGE = "Could not load the default credentials";
const QUOTA_PROJECT_APIS =
  "Enable the Google Analytics Data API, Google Analytics Admin API, and Google Search Console API in the quota project.";
const ADC_LOGIN =
  "gcloud auth application-default login --client-id-file=client.json --scopes=https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform";
const configDir = () =>
  process.env["XDG_CONFIG_HOME"]
    ? join(process.env["XDG_CONFIG_HOME"], "google-analytics-axi")
    : join(homedir(), ".config", "google-analytics-axi");
const configFile = () => join(configDir(), "config.json");
const fail = (message: string): never => {
  throw new Error(message);
};

type Config = { serviceAccountPath?: string; quotaProjectId?: string };
type ServiceAccount = {
  type: "service_account";
  client_email: string;
  private_key: string;
  project_id?: string;
  quota_project_id?: string;
};
type CredentialKind = "authorized_user" | "service_account";
type AuthFactory = (options: GoogleAuthOptions) => Pick<GoogleAuth, "getApplicationDefault" | "getClient">;
type ProviderOptions = { quotaProject?: string; authFactory?: AuthFactory };
export type AuthProvider = {
  client: AuthClient;
  type: CredentialKind;
  source: "GOOGLE_ANALYTICS_AXI_SA_KEY" | "GOOGLE_APPLICATION_CREDENTIALS" | "service-account-path" | "ADC";
  email?: string;
  quotaProjectId?: string;
};

function readConfig(): Config {
  try {
    const data: unknown = JSON.parse(readFileSync(configFile(), "utf8"));
    if (data && typeof data === "object") {
      const config: Config = {};
      if ("serviceAccountPath" in data && typeof data.serviceAccountPath === "string")
        config.serviceAccountPath = data.serviceAccountPath;
      if ("quotaProjectId" in data && typeof data.quotaProjectId === "string")
        config.quotaProjectId = data.quotaProjectId;
      return config;
    }
  } catch {
    /* No configured path or quota project. */
  }
  return {};
}

function saveConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const path = configFile();
  const temporaryFile = `${path}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryFile, path);
}

function parseServiceAccount(data: unknown): ServiceAccount | undefined {
  if (
    !data ||
    typeof data !== "object" ||
    !("type" in data) ||
    data.type !== "service_account" ||
    !("client_email" in data) ||
    typeof data.client_email !== "string" ||
    !data.client_email.trim() ||
    !("private_key" in data) ||
    typeof data.private_key !== "string" ||
    !data.private_key.trim()
  )
    return undefined;
  return {
    type: "service_account",
    client_email: data.client_email,
    private_key: data.private_key,
    ...("project_id" in data && typeof data.project_id === "string" ? { project_id: data.project_id } : {}),
    ...("quota_project_id" in data && typeof data.quota_project_id === "string"
      ? { quota_project_id: data.quota_project_id }
      : {}),
  };
}

function readServiceAccount(path: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fail("Service-account key file is unreadable or invalid JSON");
  }
  const key = parseServiceAccount(parsed);
  if (!key) throw new Error("File is not a valid Google service-account key");
  return key;
}

export async function getAuthClient(options: ProviderOptions = {}): Promise<AuthProvider> {
  const config = readConfig();
  const serviceAccountJson = process.env["GOOGLE_ANALYTICS_AXI_SA_KEY"];
  const credentialsPath = process.env["GOOGLE_APPLICATION_CREDENTIALS"];
  const configuredPath = config.serviceAccountPath;
  let serviceAccount: ServiceAccount | undefined;
  if (serviceAccountJson !== undefined) {
    try {
      serviceAccount = parseServiceAccount(JSON.parse(serviceAccountJson));
    } catch {
      throw new Error("GOOGLE_ANALYTICS_AXI_SA_KEY must contain valid service-account JSON");
    }
  } else if (credentialsPath) {
    serviceAccount = readServiceAccount(credentialsPath);
  } else if (configuredPath) {
    serviceAccount = readServiceAccount(configuredPath);
  }
  const source =
    serviceAccountJson !== undefined
      ? "GOOGLE_ANALYTICS_AXI_SA_KEY"
      : credentialsPath
        ? "GOOGLE_APPLICATION_CREDENTIALS"
        : configuredPath
          ? "service-account-path"
          : "ADC";
  const quotaOverride = options.quotaProject ?? process.env["GOOGLE_CLOUD_QUOTA_PROJECT"] ?? config.quotaProjectId;
  if (serviceAccount) {
    const credential = new JWT({ email: serviceAccount.client_email, key: serviceAccount.private_key, scopes: SCOPES });
    credential.quotaProjectId = quotaOverride ?? serviceAccount.quota_project_id;
    return {
      client: credential,
      type: "service_account",
      source,
      email: serviceAccount.client_email,
      ...(credential.quotaProjectId ? { quotaProjectId: credential.quotaProjectId } : {}),
    };
  }
  const auth = (options.authFactory ?? ((opts) => new GoogleAuth(opts)))({
    scopes: SCOPES,
    ...(quotaOverride ? { clientOptions: { quotaProjectId: quotaOverride } } : {}),
  });
  let credential: AuthClient;
  try {
    ({ credential } = await auth.getApplicationDefault());
  } catch (error) {
    if (error instanceof Error && error.message.includes(NO_ADC_MESSAGE))
      throw new Error("Google Application Default Credentials are not configured");
    throw error;
  }
  if (quotaOverride) credential.quotaProjectId = quotaOverride;
  if (credential instanceof UserRefreshClient)
    return {
      client: credential,
      type: "authorized_user",
      source: "ADC",
      ...((quotaOverride ?? credential.quotaProjectId)
        ? { quotaProjectId: quotaOverride ?? credential.quotaProjectId }
        : {}),
    };
  throw new Error("Unsupported Google ADC type; use authorized_user or service_account credentials");
}

const agentSetup = [
  "Recommended for agents and CI:",
  "1. Create a service account in a dedicated Google Cloud project and enable the Google Analytics Data API, Google Analytics Admin API, and Google Search Console API.",
  "2. Create a JSON key and add the service account as Viewer on the GA4 property and as a user in Search Console.",
  "3. Set GOOGLE_ANALYTICS_AXI_SA_KEY to the JSON string, set GOOGLE_APPLICATION_CREDENTIALS to its path, or run google-analytics-axi setup service-account <key.json>.",
];
const personalSetup = [
  "For personal ADC:",
  "Create a Google Cloud project, enable the required APIs, configure the OAuth consent screen and add your own Desktop OAuth client, then run:",
  ADC_LOGIN,
  "Set the quota project with: gcloud auth application-default set-quota-project <project>.",
];

function setupInstructions(): string[] {
  return [...agentSetup, QUOTA_PROJECT_APIS, ...personalSetup];
}

function result(data: object): string {
  return encode(data);
}

async function authStatus(quotaProject?: string, providerOptions: ProviderOptions = {}): Promise<string> {
  try {
    const auth = await getAuthClient({ ...providerOptions, quotaProject });
    const help =
      auth.type === "authorized_user" && !auth.quotaProjectId
        ? [
            "Set a quota project with `gcloud auth application-default set-quota-project <project>`.",
            QUOTA_PROJECT_APIS,
          ]
        : [];
    return result({
      auth: {
        status: "configured",
        type: auth.type,
        source: auth.source,
        ...(auth.email ? { account_email: auth.email } : {}),
        quota_project: auth.quotaProjectId ?? "none",
      },
      help,
    });
  } catch (error) {
    const config = readConfig();
    const hasCredentialPath = Boolean(config.serviceAccountPath || process.env["GOOGLE_APPLICATION_CREDENTIALS"]);
    if (error instanceof Error && error.message === "Google Application Default Credentials are not configured")
      return result({ auth: { status: "not configured", type: "none" }, setup: setupInstructions() });
    if (!hasCredentialPath && error instanceof Error && error.message.includes(NO_ADC_MESSAGE))
      return result({ auth: { status: "not configured", type: "none" }, setup: setupInstructions() });
    if (
      error instanceof Error &&
      (error.message.startsWith("Service-account") || error.message.startsWith("File is not"))
    )
      return result({ auth: { status: "invalid", type: "service_account", error: error.message } });
    throw error;
  }
}

export async function setupCommand(args: string[], providerOptions: ProviderOptions = {}): Promise<string> {
  const [first, ...rest] = args;
  if (first === "--help" || first === "-h")
    return "usage: google-analytics-axi setup [--quota-project <project>] | status | service-account <key.json> | uninstall\n";
  const action = first && !first.startsWith("-") ? first : "setup";
  const operands = action === "setup" ? args : rest;
  let quotaProject: string | undefined;
  const positionals: string[] = [];
  for (let index = 0; index < operands.length; index++) {
    const value = operands[index];
    if (value === "--quota-project") {
      const next = operands[++index];
      if (!next || next.startsWith("-")) fail("--quota-project requires a project ID");
      quotaProject = next;
    } else if (value?.startsWith("-")) {
      fail(`unknown setup option '${value}'`);
    } else if (value) positionals.push(value);
  }

  if (action === "status") {
    if (positionals.length) fail("usage: google-analytics-axi setup status [--quota-project <project>]");
    return authStatus(quotaProject, providerOptions);
  }
  if (action === "uninstall") {
    if (positionals.length || quotaProject) fail("usage: google-analytics-axi setup uninstall");
    try {
      unlinkSync(configFile());
      return result({ auth: { status: "removed", config: "removed" } });
    } catch {
      return result({ auth: { status: "not configured", config: "already absent" } });
    }
  }
  if (action === "service-account") {
    const [path] = positionals;
    if (positionals.length !== 1 || !path)
      throw new Error("usage: google-analytics-axi setup service-account <key.json> [--quota-project <project>]");
    const key = readServiceAccount(path);
    saveConfig({
      ...readConfig(),
      serviceAccountPath: resolve(path),
      ...(quotaProject ? { quotaProjectId: quotaProject } : {}),
    });
    return result({ auth: { status: "configured", type: "service_account", account_email: key.client_email } });
  }
  if (action !== "setup") fail(`unknown setup action '${action}'`);
  if (positionals.length) fail("usage: google-analytics-axi setup [--quota-project <project>]");
  if (quotaProject) saveConfig({ ...readConfig(), quotaProjectId: quotaProject });
  return authStatus(quotaProject, providerOptions);
}
