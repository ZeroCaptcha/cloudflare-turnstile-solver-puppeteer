// Opens TARGET_URL in Chrome, solves its Cloudflare Turnstile widget with ZeroCaptcha, fills the
// token in, submits the form and prints where it landed:
//
//   ZEROCAPTCHA_API=https://api.zerocaptcha.io ZEROCAPTCHA_KEY=zc_live_... \
//     TARGET_URL=https://your-site.example/login node solve-turnstile.mjs
//
// HEADED=1 shows the browser. Use it only on pages you own or are allowed to automate.
import { launch } from "puppeteer";

import { solveAndSubmit } from "./src/flows.mjs";
import { zeroCaptcha } from "./src/zerocaptcha.mjs";

const target = process.env.TARGET_URL;
if (!target) {
  console.error("Set TARGET_URL to the page with the Cloudflare Turnstile widget.");
  process.exit(2);
}

const client = zeroCaptcha();
const browser = await launch({ headless: process.env.HEADED !== "1" });
try {
  const page = await browser.newPage();
  await page.goto(target);
  await solveAndSubmit(page, client);
  console.log(`Submitted. Now on ${page.url()}: ${await page.title()}`);
} finally {
  await browser.close();
}
