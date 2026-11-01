import { encode } from "@toon-format/toon";
import type { AuthProvider } from "./auth.js";

const API = "https://searchconsole.googleapis.com/webmasters/v3/sites";
export const setupGuide = [
  { step: 1, instruction: "Enable the Google Search Console API in a Google Cloud project." },
  { step: 2, instruction: "Create a service account; it needs no project-level IAM roles." },
  {
    step: 3,
    instruction: "Load its JSON key from your secret manager into SEARCH_CONSOLE_AXI_SA_KEY. Never commit the key.",
  },
  {
    step: 4,
    instruction:
      "In Search Console, add the service-account email under Settings > Users and permissions with Restricted access.",
  },
  {
    step: 5,
    instruction:
      "For personal access, use your own Desktop OAuth client and run gcloud auth application-default login --client-id-file=client.json --scopes=https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform.",
  },
];

type Site = { siteUrl: string; permissionLevel?: string };

async function request(auth: AuthProvider, url: string, method = "GET", data?: object): Promise<unknown> {
  const response = await auth.client.request({ url, method, ...(data ? { data } : {}) });
  return response.data;
}

function searchDateRange(): { startDate: string; endDate: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const date = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const today = Date.UTC(Number(date.year), Number(date.month) - 1, Number(date.day));
  const format = (offset: number) => new Date(today + offset * 86_400_000).toISOString().slice(0, 10);
  return { startDate: format(-7), endDate: format(-1) };
}

async function sites(auth: AuthProvider): Promise<Site[]> {
  const data = await request(auth, API);
  if (!data || typeof data !== "object" || !("siteEntry" in data) || !Array.isArray(data.siteEntry)) return [];
  return data.siteEntry.flatMap((site) =>
    site && typeof site === "object" && "siteUrl" in site && typeof site.siteUrl === "string"
      ? [
          {
            siteUrl: site.siteUrl,
            ...("permissionLevel" in site && typeof site.permissionLevel === "string"
              ? { permissionLevel: site.permissionLevel }
              : {}),
          },
        ]
      : [],
  );
}

export async function runSetupCheck(auth: AuthProvider): Promise<string> {
  try {
    const accessible = await sites(auth);
    const missing = accessible.length
      ? []
      : [
          "No Search Console sites visible to this account - grant access as in step 4, or none exist.",
        ];
    return encode({
      auth: { type: auth.type, source: auth.source, ...(auth.email ? { account_email: auth.email } : {}) },
      setup: { status: missing.length ? "incomplete" : "ready", missing, guide: setupGuide },
      sites: accessible
        .slice(0, 100)
        .map(({ siteUrl, permissionLevel }) => ({ site_url: siteUrl, permission: permissionLevel ?? "" })),
      truncated: accessible.length > 100,
    });
  } catch (error) {
    const status =
      error &&
      typeof error === "object" &&
      "response" in error &&
      error.response &&
      typeof error.response === "object" &&
      "status" in error.response
        ? error.response.status
        : undefined;
    const message =
      status === 403
        ? "Search Console access denied. Add the authenticated account in Search Console Settings > Users and permissions."
        : "Search Console API request failed. Check API access and network connectivity.";
    return encode({
      auth: { type: auth.type, source: auth.source },
      setup: { status: "incomplete", missing: [message], guide: setupGuide },
    });
  }
}

export async function runHome(auth: AuthProvider): Promise<string> {
  try {
    const accessible = await sites(auth);
    if (!accessible.length)
      return encode({
        tool: "search-console-axi",
        sites: "No Search Console sites visible to this account - grant access as in step 4, or none exist.",
        help: ["Run search-console-axi setup for access instructions."],
      });
    const site = accessible[0]!.siteUrl;
    const dateRange = searchDateRange();
    const query = async (dimension: "query" | "page", orderBy: string) => {
      const result = await request(auth, `${API}/${encodeURIComponent(site)}/searchAnalytics/query`, "POST", {
        ...dateRange,
        dimensions: [dimension],
        rowLimit: 10,
        orderBy: [{ field: orderBy, direction: "DESCENDING" }],
      });
      return result && typeof result === "object" && "rows" in result && Array.isArray(result.rows) ? result.rows : [];
    };
    const [summaryRows, queries, pages] = await Promise.all([
      request(auth, `${API}/${encodeURIComponent(site)}/searchAnalytics/query`, "POST", {
        ...dateRange,
      }).then((result) =>
        result && typeof result === "object" && "rows" in result && Array.isArray(result.rows) ? result.rows : [],
      ),
      query("query", "clicks"),
      query("page", "clicks"),
    ]);
    const opportunityRows = await request(auth, `${API}/${encodeURIComponent(site)}/searchAnalytics/query`, "POST", {
      ...dateRange,
      dimensions: ["page"],
      rowLimit: 1000,
      orderBy: [{ field: "impressions", direction: "DESCENDING" }],
    });
    const rows =
      opportunityRows &&
      typeof opportunityRows === "object" &&
      "rows" in opportunityRows &&
      Array.isArray(opportunityRows.rows)
        ? opportunityRows.rows
        : [];
    const opportunities = rows
      .filter(
        (row) =>
          row &&
          typeof row === "object" &&
          "ctr" in row &&
          typeof row.ctr === "number" &&
          row.ctr < 0.02 &&
          "impressions" in row &&
          typeof row.impressions === "number" &&
          row.impressions > 100,
      )
      .slice(0, 10);
    return encode({
      tool: "search-console-axi",
      site,
      sites: accessible.length,
      period: "last 7 complete days",
      totals: summaryRows[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 },
      top_queries: queries,
      top_pages: pages,
      low_ctr_opportunities: opportunities,
      help: [
        "Run search-console-axi setup check to verify access.",
        "Run search-console-axi inspect <url> --site <site> to check indexing.",
      ],
    });
  } catch {
    return encode({
      tool: "search-console-axi",
      status: "error",
      help: ["Run search-console-axi setup check for access guidance."],
    });
  }
}

export async function inspectUrl(auth: AuthProvider, url: string, siteUrl: string): Promise<string> {
  const data = await request(auth, "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", "POST", {
    inspectionUrl: url,
    siteUrl,
    languageCode: "en-US",
  });
  return encode(data && typeof data === "object" && "inspectionResult" in data ? data.inspectionResult : data);
}
