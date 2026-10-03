// The two flows, each on a Puppeteer page or browser you give it, so they fit into your own
// scripts and tests: fill a Cloudflare Turnstile widget with a token and submit its form, or open
// a page behind a Cloudflare challenge with its cf_clearance cookie.

/**
 * Runs in the page: puts the token where the widget would, in its response field (named
 * cf-turnstile-response unless the widget renames it), creating the field if the widget has not
 * rendered it, then calls the widget's data-callback as the widget would. Returns how many fields
 * it filled.
 *
 * @param {string} token
 */
export function fillTurnstileToken(token) {
  const widget = document.querySelector("[data-sitekey]");
  const name = widget?.getAttribute("data-response-field-name") || "cf-turnstile-response";
  const form = widget?.closest("form") ?? document.querySelector("form");
  let fields = [...document.querySelectorAll(`[name="${name}"]`)];
  if (fields.length === 0 && form !== null) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    form.append(input);
    fields = [input];
  }
  for (const field of fields) field.value = token;
  const callback = widget?.getAttribute("data-callback");
  if (callback && typeof window[callback] === "function") window[callback](token);
  return fields.length;
}

/**
 * The widget's settings, from its data attributes: the sitekey, and the action and cData if it
 * sets them. Waits up to 15 seconds for the widget to appear.
 *
 * @param {import("puppeteer").Page} page
 */
export async function readWidget(page) {
  const widget = await page.waitForSelector("[data-sitekey]", { timeout: 15_000 });
  return widget.evaluate((element) => ({
    websiteKey: element.getAttribute("data-sitekey"),
    action: element.getAttribute("data-action") ?? undefined,
    cdata: element.getAttribute("data-cdata") ?? undefined,
  }));
}

/**
 * Solves the Cloudflare Turnstile widget on the page, fills its token in, and submits the form
 * it sits in. Resolves once the answer to the form has loaded.
 *
 * @param {import("puppeteer").Page} page a page showing the widget
 * @param {ReturnType<typeof import("./zerocaptcha.mjs").zeroCaptcha>} client
 */
export async function solveAndSubmit(page, client) {
  const widget = await readWidget(page);
  const task = { websiteURL: page.url(), websiteKey: widget.websiteKey };
  if (widget.action !== undefined) task.action = widget.action;
  if (widget.cdata !== undefined) task.cdata = widget.cdata;
  const token = await client.solveTurnstile(task);
  // The token works once, for 300 seconds: fill it in and submit straight away.
  await page.evaluate(fillTurnstileToken, token);
  const submit = await page.$('form:has([data-sitekey]) [type="submit"]');
  await Promise.all([
    page.waitForNavigation(),
    submit === null
      ? page.$eval("form:has([data-sitekey])", (form) => form.requestSubmit())
      : submit.click(),
  ]);
  return token;
}

/**
 * Opens a page behind a Cloudflare challenge with a clearance from ZeroCaptcha: a new page with
 * the user agent the clearance was earned with, and the cf_clearance cookie. Launch the browser
 * with the same proxy the challenge task used (see proxyArguments): a clearance works only from
 * that address.
 *
 * @param {import("puppeteer").Browser} browser
 * @param {string} url the page behind the challenge
 * @param {{ cfClearance: string, userAgent: string }} clearance
 * @param {string} [proxyUrl] the proxy, for its user name and password, if it has them
 */
export async function openWithClearance(browser, url, clearance, proxyUrl) {
  const page = await browser.newPage();
  const proxy = proxyUrl === undefined ? undefined : new URL(proxyUrl);
  if (proxy !== undefined && proxy.username !== "") {
    await page.authenticate({
      username: decodeURIComponent(proxy.username),
      password: decodeURIComponent(proxy.password),
    });
  }
  await page.setUserAgent({ userAgent: clearance.userAgent });
  const { hostname, protocol } = new URL(url);
  await browser.setCookie({
    name: "cf_clearance",
    value: clearance.cfClearance,
    domain: hostname,
    path: "/",
    secure: protocol === "https:",
  });
  const response = await page.goto(url);
  return { page, status: response?.status() };
}

/**
 * Chrome's arguments to send everything through a proxy URL such as
 * http://user:pass@proxy.example.net:8080. Chrome takes the user name and password separately,
 * through page.authenticate, which openWithClearance does.
 *
 * @param {string} proxyUrl
 */
export function proxyArguments(proxyUrl) {
  const url = new URL(proxyUrl);
  return [`--proxy-server=${url.protocol}//${url.host}`];
}
