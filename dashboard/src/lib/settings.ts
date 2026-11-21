/**
 * Runtime settings, read from `/config.json` of the dashboard's own origin (docs/schema.md,
 * "HTTP API / Conventions"). Nothing is compiled in. A missing or invalid file gives a typed
 * "unavailable" result so the app can stay in Simulation_Mode.
 */

export interface Settings {
  apiUrl: string;
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  illustrationBase: string;
}

export type SettingsResult =
  | { status: "ok"; settings: Settings }
  | { status: "unavailable"; reason: string };

const REGION = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const POOL_ID = /^[a-z]{2}(-[a-z]+)+-\d+_[A-Za-z0-9]+$/;
const CLIENT_ID = /^[A-Za-z0-9]{1,128}$/;

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Accepts an absolute https URL or an absolute path on the dashboard origin. */
function isBaseLocation(value: string): boolean {
  return isHttpsUrl(value) || (value.startsWith("/") && !value.startsWith("//"));
}

/** Pure validation of a parsed `config.json`. */
export function validateSettings(raw: unknown): SettingsResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { status: "unavailable", reason: "config is not an object" };
  }
  const o = raw as Record<string, unknown>;
  const str = (key: string): string | null => {
    const v = o[key];
    return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
  };

  const apiUrl = str("apiUrl");
  const region = str("region");
  const userPoolId = str("userPoolId");
  const userPoolClientId = str("userPoolClientId");
  const illustrationBase = str("illustrationBase");

  if (apiUrl === null || !isHttpsUrl(apiUrl)) {
    return { status: "unavailable", reason: "apiUrl is missing or not an https URL" };
  }
  if (region === null || !REGION.test(region)) {
    return { status: "unavailable", reason: "region is missing or invalid" };
  }
  if (userPoolId === null || !POOL_ID.test(userPoolId)) {
    return { status: "unavailable", reason: "userPoolId is missing or invalid" };
  }
  if (userPoolClientId === null || !CLIENT_ID.test(userPoolClientId)) {
    return { status: "unavailable", reason: "userPoolClientId is missing or invalid" };
  }
  if (illustrationBase === null || !isBaseLocation(illustrationBase)) {
    return { status: "unavailable", reason: "illustrationBase is missing or invalid" };
  }

  return {
    status: "ok",
    settings: {
      apiUrl: apiUrl.replace(/\/+$/, ""),
      region,
      userPoolId,
      userPoolClientId,
      illustrationBase,
    },
  };
}

/** Loads and validates `/config.json`. Never throws and never logs. */
export async function loadSettings(
  fetchFn: typeof fetch = fetch,
  path = "/config.json",
): Promise<SettingsResult> {
  try {
    const response = await fetchFn(path, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      return { status: "unavailable", reason: `config request failed (${response.status})` };
    }
    return validateSettings(await response.json());
  } catch {
    return { status: "unavailable", reason: "config could not be loaded" };
  }
}
