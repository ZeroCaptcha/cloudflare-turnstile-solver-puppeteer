// Both flows in a real headless Chrome, against stand-ins for the API, a site with a Cloudflare
// Turnstile widget, and a site behind a Cloudflare challenge: no key, no real task, nothing spent.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { launch } from "puppeteer";

import {
  fillTurnstileToken,
  openWithClearance,
  proxyArguments,
  solveAndSubmit,
} from "../src/flows.mjs";
import { zeroCaptcha } from "../src/zerocaptcha.mjs";
import {
  CHALLENGED_SITE,
  CLEARANCE,
  KEY,
  SITEKEY,
  startApi,
  startChallengeProxy,
  startSite,
  TOKEN,
  USER_AGENT,
} from "./stand-ins.mjs";

// Chrome's sandbox needs user namespaces, which some CI runners (Ubuntu 24.04) do not grant.
const chrome = (args = []) => launch({ args: process.env.CI ? ["--no-sandbox", ...args] : args });

let api;
let client;
before(async () => {
  api = await startApi();
  client = zeroCaptcha({ api: api.url, key: KEY, intervalMs: 10 });
});
after(() => api.close());

test("fills the Cloudflare Turnstile token in and submits the form", async () => {
  const site = await startSite();
  const browser = await chrome();
  try {
    const page = await browser.newPage();
    await page.goto(`${site.url}/login`);
    const token = await solveAndSubmit(page, client);
    assert.equal(token, TOKEN);
    assert.equal(await page.title(), "Logged in");
    assert.equal(site.posted.at(-1)["cf-turnstile-response"], TOKEN);
    const create = api.requests.find((request) => request.method === "POST");
    assert.deepEqual(create.body, {
      type: "TurnstileTaskProxyless",
      websiteURL: `${site.url}/login`,
      websiteKey: SITEKEY,
      // Read from the widget, the action and cData reach the API.
      action: "login",
      cdata: "session-7f3a9c2e",
    });
  } finally {
    await browser.close();
    await site.close();
  }
});

test("the widget's callback gets the token", async () => {
  const site = await startSite();
  const browser = await chrome();
  try {
    const page = await browser.newPage();
    await page.goto(`${site.url}/login`);
    assert.equal(await page.evaluate(fillTurnstileToken, TOKEN), 1);
    assert.equal(await page.evaluate(() => document.body.dataset.callback), TOKEN);
  } finally {
    await browser.close();
    await site.close();
  }
});

test("opens a page behind a Cloudflare challenge with its clearance, through the proxy", async () => {
  const proxy = await startChallengeProxy();
  const browser = await chrome(proxyArguments(proxy.url));
  try {
    const clearance = await client.solveChallenge({
      websiteURL: CHALLENGED_SITE,
      proxy: proxy.url,
    });
    assert.deepEqual(clearance, { cfClearance: CLEARANCE, userAgent: USER_AGENT });
    const { page, status } = await openWithClearance(
      browser,
      CHALLENGED_SITE,
      clearance,
      proxy.url,
    );
    assert.equal(status, 200);
    assert.equal(await page.title(), "Welcome");
    const request = proxy.seen.find((seen) => seen.url === CHALLENGED_SITE);
    assert.equal(request.userAgent, USER_AGENT);
    assert.match(request.cookie, new RegExp(`cf_clearance=${CLEARANCE}`));
  } finally {
    await browser.close();
    await proxy.close();
  }
});

test("without the clearance the challenge page stays", async () => {
  const proxy = await startChallengeProxy();
  const browser = await chrome(proxyArguments(proxy.url));
  try {
    const page = await browser.newPage();
    const response = await page.goto(CHALLENGED_SITE);
    assert.equal(response.status(), 403);
    assert.equal(await page.title(), "Just a moment...");
  } finally {
    await browser.close();
    await proxy.close();
  }
});
