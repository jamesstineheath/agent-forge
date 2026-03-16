export interface SmokeTestResult {
  rootCheck: { passed: boolean; statusCode: number; error?: string };
  routeChecks: Array<{
    route: string;
    passed: boolean;
    statusCode: number;
    error?: string;
  }>;
  overallPassed: boolean;
}

const TIMEOUT_MS = 10_000;
const ERROR_MARKERS = [
  "Application error",
  "Internal Server Error",
  "This page could not be found",
];

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUrl(base: string): string {
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

export async function runSmokeTest(
  previewUrl: string,
  touchedRoutes: string[],
  qaToken: string
): Promise<SmokeTestResult> {
  const base = normalizeUrl(previewUrl);

  // --- Root check ---
  const rootCheck: SmokeTestResult["rootCheck"] = {
    passed: false,
    statusCode: 0,
  };

  try {
    const res = await fetchWithTimeout(`${base}/`);
    rootCheck.statusCode = res.status;

    if (res.status !== 200) {
      rootCheck.passed = false;
      rootCheck.error = `Expected 200, got ${res.status}`;
    } else {
      const body = await res.text();
      const foundMarker = ERROR_MARKERS.find((marker) => body.includes(marker));
      if (foundMarker) {
        rootCheck.passed = false;
        rootCheck.error = `Error page marker detected: "${foundMarker}"`;
      } else {
        rootCheck.passed = true;
      }
    }
  } catch (err: unknown) {
    rootCheck.passed = false;
    rootCheck.error =
      err instanceof Error ? err.message : "Unknown fetch error";
  }

  // --- Route checks ---
  const routeChecks: SmokeTestResult["routeChecks"] = [];

  for (const route of touchedRoutes) {
    const url = `${base}${route.startsWith("/") ? route : `/${route}`}`;
    const check: SmokeTestResult["routeChecks"][number] = {
      route,
      passed: false,
      statusCode: 0,
    };

    try {
      const res = await fetchWithTimeout(url, {
        headers: {
          "X-QA-Agent-Token": qaToken,
        },
      });
      check.statusCode = res.status;

      if (res.status >= 500) {
        check.passed = false;
        check.error = `5xx response: ${res.status}`;
      } else {
        // 2xx, 3xx, 4xx are all acceptable (4xx = auth/param expected)
        check.passed = true;
      }
    } catch (err: unknown) {
      check.passed = false;
      check.error =
        err instanceof Error ? err.message : "Unknown fetch error";
    }

    routeChecks.push(check);
  }

  // --- Overall result ---
  const overallPassed =
    rootCheck.passed && routeChecks.every((r) => r.passed);

  return { rootCheck, routeChecks, overallPassed };
}
