// Stand-ins on this machine for everything the flows talk to, so the tests need no key, make no
// real task and reach no real site:
//
// - an API that answers POST /v1/tasks and GET /v1/tasks/{id} as ZeroCaptcha's does, for
//   Cloudflare Turnstile and challenge-page tasks;
// - a site with a login form behind a Cloudflare Turnstile widget, which accepts only the token
//   the stand-in API hands out;
// - a proxy that answers for a site behind a Cloudflare challenge, http://site.test/: it serves the
//   page only to requests that come through it with the cf_clearance cookie and the user agent the
//   stand-in API hands out, and a "Just a moment..." page to every other.
import { createServer } from "node:http";

export const KEY = "zc_live_test_key";
export const TOKEN = "0.stand-in-turnstile-token";
export const CLEARANCE = "stand-in-cf-clearance";
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
export const SITEKEY = "1x00000000000000000000AA";
export const CHALLENGED_SITE = "http://site.test/";

async function listen(handler) {
  const server = createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => handler(request, response, text));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

const json = (response, status, body) =>
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

export async function startApi() {
  const requests = [];
  const tasks = new Map();
  const server = await listen((request, response, text) => {
    const body = text === "" ? undefined : JSON.parse(text);
    requests.push({ method: request.method, path: request.url, body });
    if (request.headers.authorization !== `Bearer ${KEY}`) {
      return json(response, 401, { code: "unauthorized", detail: "The key is not valid." });
    }
    if (request.method === "POST" && request.url === "/v1/tasks") {
      const id = crypto.randomUUID();
      tasks.set(id, { body, polls: 0 });
      return json(response, 201, { id, type: body.type, status: "queued" });
    }
    const id = request.url.replace("/v1/tasks/", "");
    const task = tasks.get(id);
    if (request.method !== "GET" || task === undefined) {
      return json(response, 404, { code: "not_found", detail: "No such task." });
    }
    task.polls += 1;
    if (task.polls === 1) return json(response, 200, { id, status: "running" });
    const solution =
      task.body.type === "CloudflareChallengeTask"
        ? {
            token: CLEARANCE,
            userAgent: USER_AGENT,
            cookie: { name: "cf_clearance", value: CLEARANCE, expiresAt: null },
          }
        : { token: TOKEN };
    return json(response, 200, { id, status: "succeeded", solution });
  });
  return { ...server, requests };
}

const LOGIN_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Log in</title></head>
<body>
  <form method="post" action="/login">
    <label>Email <input name="email" value="me@example.com"></label>
    <div class="cf-turnstile" data-sitekey="${SITEKEY}" data-action="login" data-cdata="session-7f3a9c2e" data-callback="onTurnstile"></div>
    <button type="submit">Log in</button>
  </form>
  <script>
    window.onTurnstile = (token) => { document.body.dataset.callback = token; };
  </script>
</body>
</html>`;

export async function startSite() {
  const posted = [];
  const server = await listen((request, response, text) => {
    if (request.method === "GET" && request.url === "/login") {
      return response.writeHead(200, { "content-type": "text/html" }).end(LOGIN_PAGE);
    }
    if (request.method === "POST" && request.url === "/login") {
      const form = new URLSearchParams(text);
      posted.push(Object.fromEntries(form));
      const accepted = form.get("cf-turnstile-response") === TOKEN;
      return response
        .writeHead(accepted ? 200 : 403, { "content-type": "text/html" })
        .end(
          `<!doctype html><title>${accepted ? "Logged in" : "Refused"}</title><h1>${accepted ? "Logged in" : "Refused"}</h1>`,
        );
    }
    return response.writeHead(404).end();
  });
  return { ...server, posted };
}

export async function startChallengeProxy() {
  const seen = [];
  const server = await listen((request, response) => {
    // Through a proxy, the request line carries the whole URL.
    seen.push({
      url: request.url,
      cookie: request.headers.cookie,
      userAgent: request.headers["user-agent"],
    });
    if (!request.url.startsWith(CHALLENGED_SITE)) return response.writeHead(502).end();
    const cookies = Object.fromEntries(
      (request.headers.cookie ?? "").split(/;\s*/).map((pair) => pair.split("=")),
    );
    const cleared =
      cookies.cf_clearance === CLEARANCE && request.headers["user-agent"] === USER_AGENT;
    return response
      .writeHead(cleared ? 200 : 403, { "content-type": "text/html" })
      .end(
        cleared
          ? "<!doctype html><title>Welcome</title><h1>Welcome</h1>"
          : "<!doctype html><title>Just a moment...</title><h1>Checking your browser</h1>",
      );
  });
  return { ...server, seen };
}
