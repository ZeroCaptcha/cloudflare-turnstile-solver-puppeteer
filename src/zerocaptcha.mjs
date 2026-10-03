// A small client for the ZeroCaptcha REST API: solve a Cloudflare Turnstile widget for its token,
// or a Cloudflare challenge page for its cf_clearance cookie. No dependencies: fetch, AbortSignal
// and crypto.randomUUID, as Node.js 20 and later have them. For a maintained client with callbacks
// and signature checks, use the official SDK, @zerocaptcha/sdk.

/** The API refused a request, the task ended without a result, or the wait ran out. */
export class ZeroCaptchaError extends Error {
  name = "ZeroCaptchaError";

  /**
   * @param {string} code the API's code, such as insufficient_funds or ERROR_CAPTCHA_UNSOLVABLE
   * @param {string} message
   * @param {string} [requestId] what to quote when you ask support about the request
   */
  constructor(code, message, requestId) {
    super(`${code}: ${message}`);
    this.code = code;
    this.requestId = requestId;
  }
}

/** Answers worth another try after a wait: too many requests, or a server busy or away. */
const RETRYABLE = new Set([429, 502, 503, 504]);
const ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The API's problem document (RFC 9457) as an error: its code, detail and request ID. */
function problem(response, text) {
  let fields = {};
  try {
    fields = JSON.parse(text) ?? {};
  } catch {
    // Not a problem document, such as a proxy's HTML page.
  }
  return new ZeroCaptchaError(
    fields.code ?? `http_${response.status}`,
    fields.detail ?? fields.title ?? `HTTP ${response.status}`,
    fields.request_id ?? response.headers.get("x-request-id") ?? undefined,
  );
}

/**
 * The client, from ZEROCAPTCHA_API and ZEROCAPTCHA_KEY unless you pass them.
 *
 * @param {{ api?: string, key?: string, intervalMs?: number, timeoutMs?: number }} [options]
 */
export function zeroCaptcha(options = {}) {
  const api = (options.api ?? process.env.ZEROCAPTCHA_API ?? "").replace(/\/+$/, "");
  const key = options.key ?? process.env.ZEROCAPTCHA_KEY ?? "";
  if (api === "" || key === "") throw new Error("Set ZEROCAPTCHA_API and ZEROCAPTCHA_KEY first.");
  const intervalMs = options.intervalMs ?? 2_000;
  const timeoutMs = options.timeoutMs ?? 180_000;

  /** Sends one request, trying it up to three times with the same Idempotency-Key. */
  async function request(method, path, deadline, body, idempotencyKey) {
    const headers = { Authorization: `Bearer ${key}`, Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
    for (let attempt = 1; ; attempt += 1) {
      const left = deadline - Date.now();
      if (left <= 0)
        throw new ZeroCaptchaError("timeout", `${method} ${path} ran past the deadline.`);
      let wait = attempt * 1_000;
      let failure;
      let response;
      let text;
      const init = { method, headers, signal: AbortSignal.timeout(Math.min(30_000, left)) };
      if (body !== undefined) init.body = JSON.stringify(body);
      try {
        response = await fetch(`${api}${path}`, init);
        text = await response.text();
      } catch (error) {
        // No answer, or one cut short: the same Idempotency-Key makes a retry safe.
        failure = new ZeroCaptchaError("network", String(error));
      }
      if (response !== undefined && text !== undefined) {
        if (response.ok) {
          try {
            return JSON.parse(text);
          } catch {
            failure = new ZeroCaptchaError("network", "The answer was cut short.");
          }
        } else {
          failure = problem(response, text);
          const retryable =
            RETRYABLE.has(response.status) ||
            (response.status === 409 && failure.code === "idempotency_key_in_use");
          if (!retryable) throw failure;
          const asked = response.headers.get("retry-after");
          if (asked !== null && /^\d+$/.test(asked.trim())) wait = Number(asked) * 1_000;
        }
      }
      if (attempt >= ATTEMPTS) throw failure;
      if (Date.now() + wait >= deadline) {
        throw new ZeroCaptchaError("timeout", `${method} ${path} ran past the deadline.`);
      }
      await sleep(wait);
    }
  }

  /** Creates a task and waits for it to end; resolves with it once it succeeded. */
  async function run(task) {
    const deadline = Date.now() + timeoutMs;
    // One key per task: a retry after a lost reply returns this task instead of making another.
    let current = await request("POST", "/v1/tasks", deadline, task, crypto.randomUUID());
    while (current.status === "queued" || current.status === "running") {
      if (Date.now() + intervalMs >= deadline) {
        throw new ZeroCaptchaError("timeout", `Task ${current.id} was still ${current.status}.`);
      }
      await sleep(intervalMs);
      current = await request("GET", `/v1/tasks/${current.id}`, deadline);
    }
    if (current.status === "succeeded" && current.solution) return current;
    throw new ZeroCaptchaError(
      current.errorCode ?? current.status,
      current.errorDescription ?? `The task ${current.status}; nothing was charged.`,
    );
  }

  return {
    /**
     * A Cloudflare Turnstile token for the widget: it works once, for 300 seconds.
     *
     * @param {{ websiteURL: string, websiteKey: string, action?: string, cdata?: string, proxy?: string }} task
     * @returns {Promise<string>}
     */
    async solveTurnstile(task) {
      const type = task.proxy === undefined ? "TurnstileTaskProxyless" : "TurnstileTask";
      const done = await run({ type, ...task });
      return done.solution.token;
    },

    /**
     * A Cloudflare challenge page's clearance, through your proxy: the cf_clearance cookie and
     * the user agent it is bound to. Use both, through the same proxy.
     *
     * @param {{ websiteURL: string, proxy: string }} task
     * @returns {Promise<{ cfClearance: string, userAgent: string }>}
     */
    async solveChallenge(task) {
      const done = await run({ type: "CloudflareChallengeTask", ...task });
      return { cfClearance: done.solution.cookie.value, userAgent: done.solution.userAgent };
    },
  };
}
