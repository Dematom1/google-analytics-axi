import { BetaAnalyticsDataClient } from "@google-analytics/data";
import { encode } from "@toon-format/toon";
import type { AuthProvider } from "./auth.js";

const SCOPES = [
  "https://www.googleapis.com/auth/analytics.readonly",
  "https://www.googleapis.com/auth/webmasters.readonly",
];

export type SetupCheckOptions = {
  propertyId?: string;
  request?: (auth: AuthProvider, url: string) => Promise<unknown>;
  runReport?: (auth: AuthProvider, propertyId: string) => Promise<unknown>;
};

type ErrorInfo = { status?: number; service?: string; project?: string; serviceDisabled: boolean };

export const setupGuide = [
  { step: 1, instruction: "Create or reuse a dedicated Google Cloud project; the service account needs no IAM roles." },
  {
    step: 2,
    instruction:
      "Enable Google Analytics Data API, Google Analytics Admin API, and Google Search Console API in that project.",
  },
  { step: 3, instruction: "Create a service account, then create a JSON key for it." },
  {
    step: 4,
    instruction: "Load the key JSON from your secret manager into GOOGLE_ANALYTICS_AXI_SA_KEY. Never commit the key.",
  },
  {
    step: 5,
    instruction:
      "In GA4, open Admin > Property access management > + > Add users, enter the service-account email, untick notify, and grant Viewer.",
  },
  {
    step: 6,
    instruction:
      "In Search Console, open Settings > Users and permissions > Add user, enter the service-account email, and grant Restricted.",
  },
  {
    step: 7,
    instruction:
      "For personal access, create your own Desktop OAuth client and run gcloud auth application-default login --client-id-file=client.json --scopes=https://www.googleapis.com/auth/analytics.readonly,https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform.",
  },
  {
    step: 8,
    instruction:
      "Do not use Google's built-in gcloud client for these scopes or create a client in a project whose consent screen serves another app. If you save then delete a key file, chain commands with &&, not &.",
  },
];

function errorInfo(error: unknown): ErrorInfo {
  if (!error || typeof error !== "object") return { serviceDisabled: false };
  const response = "response" in error && error.response && typeof error.response === "object" ? error.response : {};
  const status = "status" in response && typeof response.status === "number" ? response.status : undefined;
  const data = "data" in response && response.data && typeof response.data === "object" ? response.data : {};
  const apiError = "error" in data && data.error && typeof data.error === "object" ? data.error : {};
  const details = "details" in apiError && Array.isArray(apiError.details) ? apiError.details : [];
  const legacyErrors = "errors" in apiError && Array.isArray(apiError.errors) ? apiError.errors : [];
  const disabled = details.find(
    (item) => item && typeof item === "object" && "reason" in item && item.reason === "SERVICE_DISABLED",
  );
  const legacyDisabled = legacyErrors.some(
    (item) =>
      item &&
      typeof item === "object" &&
      "reason" in item &&
      (item.reason === "accessNotConfigured" || item.reason === "SERVICE_DISABLED"),
  );
  const metadata =
    disabled && "metadata" in disabled && disabled.metadata && typeof disabled.metadata === "object"
      ? disabled.metadata
      : {};
  const service = "service" in metadata && typeof metadata.service === "string" ? metadata.service : undefined;
  const consumer = "consumer" in metadata && typeof metadata.consumer === "string" ? metadata.consumer : undefined;
  const message = "message" in apiError && typeof apiError.message === "string" ? apiError.message : "";
  const project = consumer?.match(/projects\/([^/]+)/)?.[1] ?? message.match(/project(?:s)?[\s/:=]+([\w.-]+)/i)?.[1];
  return {
    ...(status ? { status } : {}),
    ...(service ? { service } : {}),
    ...(project ? { project } : {}),
    serviceDisabled: Boolean(disabled) || legacyDisabled,
  };
}

function apiName(service: string | undefined, fallback: string): string {
  if (service?.includes("analyticsdata")) return "Google Analytics Data API";
  if (service?.includes("analyticsadmin")) return "Google Analytics Admin API";
  if (service?.includes("searchconsole") || service?.includes("webmasters")) return "Google Search Console API";
  return fallback;
}

function issue(error: unknown, auth: AuthProvider, fallbackApi: string, accessHelp: string): string {
  const info = errorInfo(error);
  if (info.serviceDisabled) {
    const api = apiName(info.service, fallbackApi);
    const project = info.project ?? auth.projectId ?? auth.quotaProjectId;
    return `Enable ${api}${project ? ` in project ${project}` : " in your Google Cloud project"} (Google Cloud Console > APIs & Services).`;
  }
  if (info.status === 403) return accessHelp;
  return `${fallbackApi} request failed${info.status ? ` (HTTP ${info.status})` : ""}. Check network access and Google API availability.`;
}

async function googleRequest(auth: AuthProvider, url: string): Promise<unknown> {
  const response = await auth.client.request({ url });
  return response.data;
}

async function googleReport(auth: AuthProvider, propertyId: string): Promise<unknown> {
  const client = new BetaAnalyticsDataClient({ authClient: auth.client, scopes: SCOPES, projectId: auth.projectId });
  try {
    const [report] = await client.runReport({
      property: `properties/${propertyId.replace(/^properties\//, "")}`,
      dateRanges: [{ startDate: "6daysAgo", endDate: "today" }],
      metrics: [{ name: "sessions" }, { name: "activeUsers" }],
      limit: 1,
    });
    return report;
  } finally {
    await client.close();
  }
}

function rows(data: unknown, name: string): unknown[] {
  if (!data || typeof data !== "object") return [];
  const value: unknown = Reflect.get(data, name);
  return Array.isArray(value) ? value : [];
}

function propertyEntries(summaries: unknown[]): { property_id: string; display_name: string }[] {
  return summaries.flatMap((summary) => {
    if (!summary || typeof summary !== "object" || !("propertySummaries" in summary)) return [];
    const properties = Array.isArray(summary.propertySummaries) ? summary.propertySummaries : [];
    return properties.flatMap((property) => {
      if (
        !property ||
        typeof property !== "object" ||
        !("property" in property) ||
        typeof property.property !== "string"
      )
        return [];
      return [
        {
          property_id: property.property.replace(/^properties\//, ""),
          display_name:
            "displayName" in property && typeof property.displayName === "string" ? property.displayName : "",
        },
      ];
    });
  });
}

function siteEntries(sites: unknown[]): { site_url: string; permission: string }[] {
  return sites.flatMap((site) => {
    if (!site || typeof site !== "object" || !("siteUrl" in site) || typeof site.siteUrl !== "string") return [];
    return [
      {
        site_url: site.siteUrl,
        permission: "permissionLevel" in site && typeof site.permissionLevel === "string" ? site.permissionLevel : "",
      },
    ];
  });
}

function metricTotals(report: unknown): Record<string, string> {
  if (!report || typeof report !== "object" || !("rows" in report) || !Array.isArray(report.rows))
    return { sessions: "0", active_users: "0" };
  const first = report.rows[0];
  if (!first || typeof first !== "object" || !("metricValues" in first) || !Array.isArray(first.metricValues))
    return { sessions: "0", active_users: "0" };
  const values = first.metricValues;
  const valueAt = (index: number) => {
    const item = values[index];
    return item && typeof item === "object" && "value" in item ? String(item.value) : "0";
  };
  return { sessions: valueAt(0), active_users: valueAt(1) };
}

export async function runSetupCheck(auth: AuthProvider, options: SetupCheckOptions = {}): Promise<string> {
  const request = options.request ?? googleRequest;
  const report = options.runReport ?? googleReport;
  const email = auth.email ?? "the authenticated account";
  const missing: string[] = [];
  const errors: { step: string; message: string }[] = [];
  let properties: { property_id: string; display_name: string }[] = [];
  let sites: { site_url: string; permission: string }[] = [];

  try {
    const response = await request(auth, "https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200");
    properties = propertyEntries(rows(response, "accountSummaries"));
    if (!properties.length)
      missing.push(
        `No GA4 properties are accessible. Add ${email} as Viewer in GA4 Admin > Property access management > + > Add users; untick notify.`,
      );
  } catch (error) {
    const message = issue(
      error,
      auth,
      "Google Analytics Admin API",
      `GA4 access denied. Add ${email} as Viewer in GA4 Admin > Property access management > + > Add users; untick notify.`,
    );
    errors.push({ step: "ga4_properties", message });
    if (message.startsWith("Enable ")) missing.push(message);
    else if (errorInfo(error).status === 403) missing.push(message);
  }

  try {
    const response = await request(auth, "https://searchconsole.googleapis.com/webmasters/v3/sites");
    sites = siteEntries(rows(response, "siteEntry"));
    if (!sites.length)
      missing.push(
        `No Search Console sites are accessible. Add ${email} as Restricted in Search Console Settings > Users and permissions > Add user.`,
      );
  } catch (error) {
    const message = issue(
      error,
      auth,
      "Google Search Console API",
      `Search Console access denied. Add ${email} as Restricted in Search Console Settings > Users and permissions > Add user.`,
    );
    errors.push({ step: "search_console_sites", message });
    if (message.startsWith("Enable ")) missing.push(message);
    else if (errorInfo(error).status === 403) missing.push(message);
  }

  const propertyId = properties.length
    ? (options.propertyId?.replace(/^properties\//, "") ?? properties[0]?.property_id)
    : undefined;
  let reportResult: { status: string; property_id?: string; date_range?: string; totals?: Record<string, string> };
  if (!propertyId) {
    reportResult = { status: "skipped" };
  } else {
    try {
      const response = await report(auth, propertyId);
      reportResult = {
        status: "ok",
        property_id: propertyId,
        date_range: "last 7 days",
        totals: metricTotals(response),
      };
    } catch (error) {
      const message = issue(
        error,
        auth,
        "Google Analytics Data API",
        `GA4 report access denied for ${email}; add the account as Viewer in GA4 Admin > Property access management > + > Add users.`,
      );
      reportResult = { status: "error", property_id: propertyId };
      errors.push({ step: "ga4_report", message });
      if (message.startsWith("Enable ")) missing.push(message);
      else if (errorInfo(error).status === 403) missing.push(message);
    }
  }

  return encode({
    auth: { type: auth.type, source: auth.source, ...(auth.email ? { account_email: auth.email } : {}) },
    setup: { status: missing.length || errors.length ? "incomplete" : "ready", missing, guide: setupGuide },
    ga4_properties: properties.slice(0, 100),
    search_console_sites: sites.slice(0, 100),
    truncated: { ga4_properties: properties.length > 100, search_console_sites: sites.length > 100 },
    report: reportResult,
    errors,
  });
}
