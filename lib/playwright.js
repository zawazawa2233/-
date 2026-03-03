import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright";

export const NAVIGATION_TIMEOUT_MS = 20000;

export function resolveChromiumExecutablePath() {
  const defaultPath = chromium.executablePath();
  const chromiumRoot = path.dirname(path.dirname(path.dirname(path.dirname(defaultPath))));
  const headlessRoot = path.join(path.dirname(chromiumRoot), path.basename(chromiumRoot).replace("chromium-", "chromium_headless_shell-"));
  const candidates = [
    defaultPath,
    defaultPath.replace("mac-x64", "mac-arm64"),
    defaultPath.replace("mac-arm64", "mac-x64"),
    path.join(headlessRoot, "chrome-headless-shell-mac-arm64", "chrome-headless-shell"),
    path.join(headlessRoot, "chrome-headless-shell-mac-x64", "chrome-headless-shell"),
    path.join(
      os.homedir(),
      "Library",
      "Caches",
      "ms-playwright",
      path.basename(headlessRoot),
      "chrome-headless-shell-mac-arm64",
      "chrome-headless-shell"
    ),
    path.join(
      os.homedir(),
      "Library",
      "Caches",
      "ms-playwright",
      path.basename(headlessRoot),
      "chrome-headless-shell-mac-x64",
      "chrome-headless-shell"
    )
  ];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return defaultPath;
}

export async function launchBrowser() {
  return chromium.launch({
    headless: true,
    executablePath: resolveChromiumExecutablePath()
  });
}

export async function createBrowserContext(browser) {
  const context = await browser.newContext({
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo"
  });

  await context.route("**/*", async (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    const url = request.url();

    if (["image", "font", "media"].includes(resourceType)) {
      await route.abort();
      return;
    }

    if (/google-analytics|googletagmanager|doubleclick|adsystem/i.test(url)) {
      await route.abort();
      return;
    }

    await route.continue();
  });

  return context;
}

export async function preparePage(page) {
  page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
  await page.setViewportSize({ width: 1440, height: 1600 });
}
