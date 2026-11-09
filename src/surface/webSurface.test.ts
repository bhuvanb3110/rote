// Unit tests for WebSurface.perceive()'s screenshot retry (docs/DECISIONS.md D8). No browser is
// launched: a fake Page stands in, so the failure sequence is exact rather than load-dependent.
import { describe, expect, it } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";
import { WebSurface } from "./webSurface.js";

const TRANSIENT = "page.screenshot: Protocol error (Page.captureScreenshot): Unable to capture screenshot";

/** A fake Page whose screenshot() fails with the given messages, in order, then succeeds. */
function fakePage(failures: string[]): { page: Page; screenshotCalls: () => number } {
  let calls = 0;
  const page = {
    url: () => "http://localhost:4100/",
    screenshot: async () => {
      calls += 1;
      const failure = failures[calls - 1];
      if (failure !== undefined) throw new Error(failure);
      return Buffer.from("fake-png");
    },
    locator: () => ({
      ariaSnapshot: async () => "- heading \"Member Lookup\"",
      innerText: async () => "Member Lookup",
      allInnerTexts: async () => ["Member Lookup"],
    }),
  };
  return { page: page as unknown as Page, screenshotCalls: () => calls };
}

// The constructor is private (callers use WebSurface.launch()); a test may reach it directly to
// inject the fake page.
function surfaceFor(page: Page): WebSurface {
  const Ctor = WebSurface as unknown as new (b: Browser, c: BrowserContext, p: Page) => WebSurface;
  return new Ctor({} as Browser, {} as BrowserContext, page);
}

describe("WebSurface.perceive screenshot retry", () => {
  it("retries a transient 'Unable to capture screenshot' once and returns the screenshot", async () => {
    const { page, screenshotCalls } = fakePage([TRANSIENT]);
    const surface = surfaceFor(page);
    expect(surface.screenshotRetries).toBe(0);

    const observation = await surface.perceive();

    expect(observation.screenshot.toString()).toBe("fake-png");
    expect(observation.visibleText).toBe("Member Lookup");
    expect(surface.screenshotRetries).toBe(1);
    expect(screenshotCalls()).toBe(2);
  });

  it("throws the original error after 3 failed attempts", async () => {
    const { page, screenshotCalls } = fakePage([TRANSIENT, TRANSIENT, TRANSIENT]);
    const surface = surfaceFor(page);

    await expect(surface.perceive()).rejects.toThrow(/Unable to capture screenshot/);
    expect(screenshotCalls()).toBe(3);
    expect(surface.screenshotRetries).toBe(2);
  });

  it("does not retry a different error", async () => {
    const { page, screenshotCalls } = fakePage(["Target page, context or browser has been closed"]);
    const surface = surfaceFor(page);

    await expect(surface.perceive()).rejects.toThrow(/has been closed/);
    expect(screenshotCalls()).toBe(1);
    expect(surface.screenshotRetries).toBe(0);
  });
});
