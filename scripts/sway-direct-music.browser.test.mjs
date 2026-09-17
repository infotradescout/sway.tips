// Full signed-in Sway app, real HTTP and database. Only third-party consent/API are simulated.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  renameSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { startEmbeddedPostgresProof } from "./lib/embedded-postgres-proof.ts";
const out =
  "tmp/direct-music-proof/" +
  (process.env.SWAY_REAL_POSTGRES_PROOF_DATABASE_URL ? "native" : "embedded");
mkdirSync(out, { recursive: true });
const fixtureDirectory = mkdtempSync(
    join(tmpdir(), "sway-direct-music-fixture-"),
  ),
  fixtureFile = join(fixtureDirectory, "provider.json");
const report = {
  startedAt: new Date().toISOString(),
  scope:
    "Actual signed-in application with synthetic OAuth consent and provider replies. No real music provider, physical playback, or production writes.",
  checks: [],
  passed: false,
};
const safeEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) =>
    /^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|HOME|APPDATA|LOCALAPPDATA|TEMP|TMP|NUMBER_OF_PROCESSORS)$/i.test(
      k,
    ),
  ),
);
Object.assign(safeEnv, {
  NODE_ENV: "test",
  CI: "true",
  TZ: "UTC",
  SWAY_LIVE_ROOM_LIVE_MONEY_ENABLED: "false",
  SWAY_NATIVE_TICKETS_ENABLED: "false",
  SWAY_PAYPAL_PAYOUTS_TEST_EXECUTION_ENABLED: "false",
  SWAY_PAYPAL_PAYOUTS_LIVE_EXECUTION_ENABLED: "false",
  SWAY_TEST_MODE_PLATFORM_BALANCE_ENABLED: "false",
});
let proof,
  browser,
  child,
  baseUrl,
  serverTail = "",
  currentStage = "initialization";
writeFileSync(
  fixtureFile,
  JSON.stringify({ playing: false, currentTrack: null }),
);
function configure(values) {
  const file = fixtureFile + "." + randomUUID();
  writeFileSync(
    file,
    JSON.stringify({
      ...JSON.parse(readFileSync(fixtureFile, "utf8")),
      ...values,
    }),
  );
  renameSync(file, fixtureFile);
}
function requests() {
  try {
    return readFileSync(fixtureFile + ".requests", "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((s) => JSON.parse(s));
  } catch {
    return [];
  }
}
const commands = () =>
  requests().filter(
    (r) => r.path.startsWith("/v1/me/player") && r.method !== "GET",
  );
const record = (name) => {
  report.checks.push(name);
  console.log("DIRECT_MUSIC_BROWSER_PASS " + name);
};
const panel = (page) => page.locator("[data-sway-direct-music]");
async function connect(page, { cancel = false, reconnect = false } = {}) {
  currentStage = "provider account connection";
  if (reconnect) page.once("dialog", (dialog) => dialog.accept());
  await panel(page)
    .getByRole("button", {
      name: reconnect ? "Reconnect Spotify" : "Connect Spotify",
      exact: true,
    })
    .click();
  await page.getByRole("heading", { name: "Test provider consent" }).waitFor();
  await page
    .getByRole("link", {
      name: cancel ? "Cancel connection" : "Authorize test account",
      exact: true,
    })
    .click();
  if (cancel) {
    await panel(page)
      .getByRole("alert")
      .filter({ hasText: "canceled" })
      .waitFor();
    return;
  }
  await panel(page)
    .getByText("Connected fixture listener \u00b7 Account connected", {
      exact: true,
    })
    .waitFor();
}
async function doCommand(page, name) {
  const response = page.waitForResponse(
    (r) =>
      r.url().includes("/direct-music/") &&
      r.url().endsWith("/commands") &&
      r.request().method() === "POST",
  );
  await panel(page).getByRole("button", { name, exact: true }).click();
  const result = await response;
  assert.equal(result.status(), 202);
  return result.json();
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function port() {
  const socket = createServer();
  await new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", resolve);
  });
  const p = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return p;
}
async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (
    let i = 0;
    i < 50 && child.exitCode === null && child.signalCode === null;
    i++
  )
    await delay(100);
  if (child.exitCode === null && child.signalCode === null)
    child.kill("SIGKILL");
}
async function startServer(listenPort, approved = true) {
  baseUrl = `http://127.0.0.1:${listenPort}`;
  child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      pathToFileURL(resolve("scripts/fixtures/direct-music-provider.mjs")).href,
      "server.ts",
    ],
    {
      env: {
        ...safeEnv,
        NODE_ENV: "test",
        PORT: String(listenPort),
        DATABASE_URL: proof.databaseUrl,
        SWAY_APP_BASE_URL: baseUrl,
        APP_URL: baseUrl,
        APP_BASE_URL: baseUrl,
        VITE_SWAY_DEMO_MODE: "false",
        SWAY_LIVE_ROOM_DURABILITY_WRITES_DISABLED: "false",
        DISABLE_HMR: "true",
        STRIPE_SECRET_KEY: "",
        STRIPE_PUBLISHABLE_KEY: "",
        VITE_STRIPE_PUBLISHABLE_KEY: "",
        STRIPE_WEBHOOK_SECRET: "",
        SWAY_EMAIL_PROVIDER: "",
        SWAY_EMAIL_API_KEY: "",
        SWAY_EMAIL_FROM: "",
        SWAY_SPOTIFY_CLIENT_ID: "a".repeat(32),
        SWAY_SPOTIFY_CLIENT_SECRET: "",
        SWAY_DIRECT_MUSIC_FIXTURE: fixtureFile,
        SWAY_MUSIC_TOKEN_KEY: Buffer.alloc(32, 9).toString("base64"),
        SWAY_SPOTIFY_DIRECT_USE_APPROVED: approved ? "true" : "false",
        SWAY_SPOTIFY_DIRECT_APPROVAL_REFERENCE: "isolated-synthetic-test-only",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const consume = (data) => {
    serverTail = (serverTail + data.toString()).slice(-12000);
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error("Local Sway server exited before readiness.");
    try {
      if (
        (
          await fetch(baseUrl + "/api/health/network-probe", {
            signal: AbortSignal.timeout(1000),
          })
        ).status === 204
      )
        return;
    } catch {}
    await delay(100);
  }
  throw new Error("Local Sway server did not become ready.");
}
async function newAccount(label) {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  const email = `sources-${suffix}@example.test`,
    password = `SwaySources!2026-${suffix}`;
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  });
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(baseUrl + "/") || /^(data|blob):/.test(url))
      return route.continue();
    if (url.startsWith("https://accounts.spotify.com/authorize?")) {
      const u = new URL(url),
        redirect = new URL(u.searchParams.get("redirect_uri"));
      assert.equal(redirect.origin, baseUrl);
      assert.equal(
        redirect.pathname,
        "/api/talent/direct-music/spotify/callback",
      );
      assert.equal(u.searchParams.get("code_challenge_method"), "S256");
      const code = "fixture-code-" + randomUUID();
      configure({
        code,
        challenge: u.searchParams.get("code_challenge"),
        redirectUri: redirect.href,
      });
      const accept = new URL(redirect);
      accept.search = new URLSearchParams({
        state: u.searchParams.get("state"),
        code,
      }).toString();
      const cancel = new URL(redirect);
      cancel.search = new URLSearchParams({
        state: u.searchParams.get("state"),
        error: "access_denied",
      }).toString();
      return route.fulfill({
        contentType: "text/html",
        body:
          '<!doctype html><title>Synthetic provider consent</title><h1>Test provider consent</h1><a href="' +
          accept.href.replaceAll("&", "&amp;") +
          '">Authorize test account</a><a href="' +
          cancel.href.replaceAll("&", "&amp;") +
          '">Cancel connection</a>',
      });
    }
    return route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  currentStage = label + " signup";
  await page.goto(baseUrl + "/account/signup?intent=performer");
  await page
    .getByRole("heading", { name: "Create your Sway account" })
    .waitFor();
  await page.getByLabel("Your name").fill("Sources " + label);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByLabel("I accept the Sway Terms.").check();
  await page.getByRole("button", { name: "Create account" }).click();
  const link = page.getByRole("link", { name: "Open local verification link" });
  await link.waitFor();
  assert.equal(
    new URL(await link.getAttribute("href"), baseUrl).origin,
    new URL(baseUrl).origin,
  );
  await Promise.all([
    page.waitForURL(
      (url) =>
        url.pathname === "/account/login" &&
        url.searchParams.get("verified") === "1",
    ),
    link.click(),
  ]);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/account"),
    page.getByRole("button", { name: "Log in" }).click(),
  ]);
  await page.getByRole("heading", { name: "Activate Pro Mode" }).waitFor();
  await page.getByLabel("Performer name").fill("Sources " + label);
  await page.getByLabel("Public handle").fill("sources-" + suffix);
  await Promise.all([
    page.waitForURL((url) => url.pathname === "/talent"),
    page.getByRole("button", { name: "Activate Pro Mode" }).click(),
  ]);
  await page.goto(baseUrl + "/talent/connections");
  await page.locator("[data-sway-direct-music]").waitFor();
  return { page, context, errors };
}
async function api(context, path) {
  const response = await context.request.get(baseUrl + path);
  assert.equal(response.status(), 200);
  return response.json();
}

try {
  proof = await startEmbeddedPostgresProof("direct_music_browser");
  report.database = proof.kind;
  const listenPort = await port();
  await startServer(listenPort);
  browser = await chromium.launch({ headless: true });
  const a = await newAccount("Direct music owner");
  const sourceInfo = await api(a.context, "/api/talent/library/sources");
  const owner = sourceInfo.performerId;
  assert.deepEqual(sourceInfo.sources, []);
  const root = panel(a.page);
  await root
    .getByRole("button", { name: "Connect Spotify", exact: true })
    .waitFor();
  assert.equal(await root.locator("input[type=file]").count(), 0);
  assert(
    (await root.boundingBox()).y <
      (await a.page.locator("[data-sway-source-import-choices]").boundingBox())
        .y,
  );
  record(
    "Direct account connection appears before file imports and requires no live room or CSV",
  );
  await connect(a.page, { cancel: true });
  assert.equal(
    (await api(a.context, "/api/talent/direct-music?performerId=" + owner))
      .connections.length,
    0,
  );
  record(
    "Provider consent cancellation returns useful feedback without attaching an account",
  );
  await connect(a.page);
  await root
    .getByRole("button", { name: "My connected playlist", exact: true })
    .waitFor();
  let overview = await api(
      a.context,
      "/api/talent/direct-music?performerId=" + owner,
    ),
    saved = overview.connections[0];
  assert(saved.id && saved.revision);
  assert.equal(saved.selectedDeviceId, null);
  const stored = await proof.query(
    "select sealed_tokens from direct_music_credentials where connection_id=$1",
    [saved.id],
  );
  assert.equal(stored.rows.length, 1);
  assert(!stored.rows[0].sealed_tokens.includes("fixture-token"));
  record(
    "Actual OAuth callback validates PKCE and saves encrypted account credentials through the normal signed-in route",
  );
  await root
    .getByRole("button", { name: "My connected playlist", exact: true })
    .click();
  await root
    .getByRole("button", { name: "Play Fixture first song", exact: true })
    .waitFor();
  assert.equal(
    await root
      .getByRole("button", { name: "Play Fixture first song", exact: true })
      .isEnabled(),
    false,
  );
  assert.equal(
    await root.locator('option[value="fixture-restricted"]').isDisabled(),
    true,
  );
  assert.equal(commands().length, 0);
  await root.getByLabel("Playback destination").selectOption("fixture-laptop");
  await root
    .getByRole("status")
    .filter({ hasText: "Playback destination selected" })
    .waitFor();
  assert.equal(commands().length, 0);
  assert.equal(
    (await api(a.context, "/api/talent/direct-music?performerId=" + owner))
      .connections[0].selectedDeviceId,
    "fixture-laptop",
  );
  record(
    "Selecting a currently available player persists the target without starting audio; restricted devices stay disabled",
  );
  configure({ holdState: true });
  const play = await doCommand(a.page, "Play Fixture first song");
  assert.equal(play.status, "accepted");
  await root.getByText("Paused on Fixture laptop", { exact: true }).waitFor();
  assert.equal(
    await root.getByText("Playing on Fixture laptop", { exact: true }).count(),
    0,
  );
  record(
    "Accepted Play command does not fabricate Playing before a separately observed provider response",
  );
  configure({
    holdState: false,
    playing: true,
    currentTrack: "4uLU6hMCjMI75M1A2tKUQC",
  });
  await root.getByText("Playing on Fixture laptop", { exact: true }).waitFor();
  const firstCommand = commands()[0];
  assert.equal(firstCommand.path, "/v1/me/player/play");
  assert.equal(
    new URLSearchParams(firstCommand.query).get("device_id"),
    "fixture-laptop",
  );
  await doCommand(a.page, "Pause");
  await root.getByText("Paused on Fixture laptop", { exact: true }).waitFor();
  await doCommand(a.page, "Resume");
  await root.getByText("Playing on Fixture laptop", { exact: true }).waitFor();
  await doCommand(a.page, "Queue Fixture next song");
  await doCommand(a.page, "Next");
  await root
    .locator("[data-sway-direct-playback]")
    .getByRole("link", { name: "Fixture next song", exact: true })
    .waitFor();
  record(
    "Play, pause, resume, queue and next use the selected external player and display only reported track/state",
  );
  await root.getByRole("button", { name: "My playlists", exact: true }).click();
  await root
    .getByRole("button", { name: "My connected playlist", exact: true })
    .waitFor();
  configure({ playlistName: "Provider renamed this playlist" });
  await root
    .getByRole("button", {
      name: "Provider renamed this playlist",
      exact: true,
    })
    .waitFor({ timeout: 45000 });
  assert.deepEqual(
    (await api(a.context, "/api/talent/library/sources")).sources,
    [],
  );
  record(
    "Provider playlist edit appears automatically without uploading files or overwriting a saved request list",
  );
  await root.getByLabel("Search connected Spotify music").fill("Fixture");
  await root.getByRole("button", { name: "Search", exact: true }).click();
  await root
    .getByRole("button", { name: "Play Fixture first song", exact: true })
    .waitFor();
  await root.getByRole("button", { name: "Saved songs", exact: true }).click();
  await root
    .getByRole("button", { name: "Play Fixture first song", exact: true })
    .waitFor();
  record("Search and saved songs are read from the connected account");
  configure({ fail: "lost_command" });
  const count = commands().length;
  const lost = await doCommand(a.page, "Next");
  assert.equal(lost.status, "uncertain");
  assert.equal(commands().length, count + 1);
  assert.equal(
    await root.getByRole("button", { name: "Next", exact: true }).isEnabled(),
    false,
  );
  configure({ fail: null });
  await root
    .getByRole("button", { name: "Refresh players and playback", exact: true })
    .click();
  await a.page.waitForFunction(
    () =>
      !document.querySelector(
        '[data-sway-direct-music] button[aria-label="Play Fixture first song"]',
      ).disabled,
  );
  assert.equal(commands().length, count + 1);
  record(
    "Lost command outcome disables controls until manual verification and never automatically resends",
  );
  configure({ stateFailure: true });
  await root
    .getByRole("button", { name: "Refresh players and playback", exact: true })
    .click();
  await root.getByRole("alert").waitFor();
  await a.page.waitForFunction(
    () =>
      document.querySelector(
        '[data-sway-direct-music] button[aria-label="Play Fixture first song"]',
      ).disabled,
    {},
    { timeout: 15000 },
  );
  configure({ stateFailure: false });
  await root
    .getByRole("button", { name: "Refresh players and playback", exact: true })
    .click();
  await a.page.waitForFunction(
    () =>
      !document.querySelector(
        '[data-sway-direct-music] button[aria-label="Play Fixture first song"]',
      ).disabled,
  );
  record(
    "Unavailable playback feedback removes control permission and supports explicit recovery",
  );
  for (const width of [1440, 390, 320]) {
    await a.page.setViewportSize({
      width,
      height: width === 1440 ? 1000 : 844,
    });
    assert.equal(
      await a.page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 1,
      ),
      false,
    );
    await root.screenshot({ path: out + "/connected-" + width + ".png" });
  }
  record(
    "Connected account, music browsing and player controls fit desktop and narrow mobile screens",
  );
  const b = await newAccount("Other listener");
  const bInfo = await api(b.context, "/api/talent/library/sources");
  assert.equal(
    (
      await api(
        b.context,
        "/api/talent/direct-music?performerId=" + bInfo.performerId,
      )
    ).connections.length,
    0,
  );
  const foreign = await b.context.request.get(
    baseUrl +
      "/api/talent/direct-music/" +
      saved.id +
      "/read?" +
      new URLSearchParams({
        performerId: owner,
        revision: saved.revision,
        kind: "playback",
      }),
  );
  assert.equal(foreign.status(), 403);
  const requestsBefore = requests().length;
  const wrongOrigin = await a.context.request.post(
    baseUrl + "/api/talent/direct-music/" + saved.id + "/target",
    {
      headers: { Origin: "https://evil.example" },
      data: {
        performerId: owner,
        revision: saved.revision,
        deviceId: "fixture-laptop",
      },
    },
  );
  assert.equal(wrongOrigin.status(), 403);
  assert.equal(requests().length, requestsBefore);
  record(
    "A separate real account and a cross-origin mutation cannot use another account’s connection",
  );
  await a.page.goto("about:blank");
  await b.page.goto("about:blank");
  await stopServer();
  await startServer(listenPort);
  await a.page.goto(baseUrl + "/talent/connections");
  await panel(a.page)
    .getByText("Connected fixture listener \u00b7 Account connected", {
      exact: true,
    })
    .waitFor();
  assert.equal(
    await panel(a.page).getByLabel("Playback destination").inputValue(),
    "fixture-laptop",
  );
  assert.equal(
    (await api(a.context, "/api/talent/direct-music?performerId=" + owner))
      .connections[0].id,
    saved.id,
  );
  record(
    "Authenticated connection and selected device survive actual server restart and browser reload",
  );
  a.page.once("dialog", (dialog) => dialog.dismiss());
  await panel(a.page)
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  assert.equal(
    (await api(a.context, "/api/talent/direct-music?performerId=" + owner))
      .connections.length,
    1,
  );
  a.page.once("dialog", (dialog) => dialog.accept());
  await panel(a.page)
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await panel(a.page)
    .getByRole("status")
    .filter({ hasText: "Music account disconnected." })
    .waitFor();
  assert.equal(
    (await proof.query("select * from direct_music_credentials")).rows.length,
    0,
  );
  assert.equal(
    (await proof.query("select * from direct_music_commands")).rows.length,
    0,
  );
  assert.deepEqual(
    (await api(a.context, "/api/talent/library/sources")).sources,
    [],
  );
  record(
    "Confirmed disconnect deletes authorization and command records without deleting request libraries; cancel preserves access",
  );
  await a.page.goto("about:blank");
  await stopServer();
  await startServer(listenPort, false);
  await a.page.goto(baseUrl + "/talent/connections");
  await panel(a.page)
    .getByText(/awaiting provider approval/)
    .waitFor();
  assert.equal(
    await panel(a.page)
      .getByRole("button", { name: "Connect Spotify", exact: true })
      .isEnabled(),
    false,
  );
  record(
    "Absent provider approval cannot be mistaken for a working connection or enabled by a user checkbox",
  );
  assert.deepEqual(a.errors, []);
  assert.deepEqual(b.errors, []);
  report.passed = true;
  report.providerRequests = requests().length;
  report.externalCommands = commands().length;
  report.actualProviderCalls = 0;
  report.actualAudioPlayback = false;
} catch (error) {
  report.stage = currentStage;
  report.error = String(error.stack || error);
  console.error("DIRECT_MUSIC_BROWSER_ERROR " + report.error);
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    report.visibleText = (
      await page
        .locator("body")
        .innerText()
        .catch(() => "")
    ).slice(-3500);
    await page
      .screenshot({ path: out + "/failure.png", fullPage: true })
      .catch(() => {});
  }
  console.error(
    serverTail
      .split("\n")
      .filter((line) => !line.includes("[SWAY_EMAIL_MOCK]"))
      .join("\n")
      .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, "[OWNED_DATABASE]")
      .slice(-3000),
  );
} finally {
  await browser?.close();
  await stopServer();
  await proof?.close();
  rmSync(fixtureDirectory, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  writeFileSync(out + "/results.json", JSON.stringify(report, null, 2));
  console.log("DIRECT_MUSIC_BROWSER_SUMMARY " + JSON.stringify(report));
}
if (!report.passed) process.exitCode = 1;
