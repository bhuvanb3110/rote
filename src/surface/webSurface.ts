import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { resolveDescriptor } from "./locate.js";
import type {
  ElementDescriptor,
  ExecutableAction,
  Handle,
  LocatorProvenanceEntry,
  Observation,
  Surface,
} from "./types.js";

export interface WebSurfaceOptions {
  /**
   * Defaults to false (headed) — human handoff needs a real window to take over in. Ignored when
   * `browser` is given: that browser was already launched headed or headless.
   */
  headless?: boolean;
  /**
   * An already-running browser to reuse (the fleet's one-browser-per-worker). The surface opens a
   * fresh context + page on it, and close() closes ONLY that context, never the browser. Omit it
   * to launch and own a browser, exactly as before.
   */
  browser?: Browser;
}

const MAX_ARIA_SNAPSHOT_CHARS = 4000;
const MAX_VISIBLE_TEXT_CHARS = 2000;
const MAX_LANDMARKS = 40;
const WAIT_FOR_POLL_MS = 150;
const DEFAULT_WAIT_FOR_TIMEOUT_MS = 5000;

// Chromium under CPU load sometimes drops a Page.captureScreenshot call with this exact message
// (docs/REPO_NOTES.md "Known flake", docs/DECISIONS.md D8). Only that message is retried; any
// other error, or a failure on the last attempt, throws exactly as before.
const SCREENSHOT_MAX_ATTEMPTS = 3;
const SCREENSHOT_BACKOFF_MS = 100;
const TRANSIENT_SCREENSHOT_ERROR = /Unable to capture screenshot/;

/** How waiting for an action's resulting navigation ended. Never an exception. */
export type NavigationSettle =
  | { loaded: true; ms: number; url: string }
  | { loaded: false; ms: number; url: string; reason: string };

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...[truncated]` : value;
}

/**
 * Thrown when an action needs a live element but locate() only produced the "visual" fallback
 * (describedAs carried forward, no real locator — that strategy is a documented stub for now).
 */
function assertLiveLocator(
  handle: Handle | null,
  target: ElementDescriptor,
): asserts handle is Handle & { locator: NonNullable<Handle["locator"]> } {
  if (!handle || !handle.locator) {
    throw new Error(
      `Could not resolve a live locator for "${target.describedAs}" ` +
        `(only the visual fallback matched, which is a documented stub — no coordinate ` +
        `clicking implemented yet).`,
    );
  }
}

// target/value are optional on ExecutableAction's type (they're runtime-only additions to the
// persisted Action shape), but every non-navigate action needs a target, and type/selectOption
// need a value -- the artifact schema enforces this on Step at authoring time; this is the
// matching runtime check for whoever calls act() directly.
function requireTarget(action: ExecutableAction): ElementDescriptor {
  if (!action.target) {
    throw new Error(`Action "${action.kind}" requires a target, but none was provided.`);
  }
  return action.target;
}

function requireValue(action: ExecutableAction): string {
  if (action.value === undefined) {
    throw new Error(`Action "${action.kind}" requires a value, but none was provided.`);
  }
  return action.value;
}

/** WebSurface (Playwright/Chromium) — the only concrete Surface implementation for now. */
export class WebSurface implements Surface {
  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly page: Page;
  private readonly provenanceLog: LocatorProvenanceEntry[] = [];
  private lastReadTextValue: string | null = null;
  private screenshotRetryCount = 0;
  /** False when the browser was passed in: then close() must leave it running for the next job. */
  private readonly ownsBrowser: boolean;

  private constructor(browser: Browser, context: BrowserContext, page: Page, ownsBrowser = true) {
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.ownsBrowser = ownsBrowser;
  }

  static async launch(options: WebSurfaceOptions = {}): Promise<WebSurface> {
    if (options.browser) {
      const context = await options.browser.newContext();
      try {
        const page = await context.newPage();
        return new WebSurface(options.browser, context, page, false);
      } catch (err) {
        await context.close().catch(() => undefined);
        throw err;
      }
    }
    const browser = await chromium.launch({ headless: options.headless ?? false });
    const context = await browser.newContext();
    const page = await context.newPage();
    return new WebSurface(browser, context, page, true);
  }

  /** Exposed so src/escalation can hand control to a human on this SAME live session. */
  get playwrightPage(): Page {
    return this.page;
  }

  get playwrightContext(): BrowserContext {
    return this.context;
  }

  get provenance(): ReadonlyArray<LocatorProvenanceEntry> {
    return this.provenanceLog;
  }

  /** Result of the last readText action, since act() returns Promise<void> per the interface. */
  get lastReadText(): string | null {
    return this.lastReadTextValue;
  }

  /** How many screenshot captures were retried on this surface (a fleet metric later). */
  get screenshotRetries(): number {
    return this.screenshotRetryCount;
  }

  /** Closes the browser if this surface launched it, otherwise only this surface's context. */
  async close(): Promise<void> {
    if (this.ownsBrowser) {
      await this.browser.close();
    } else {
      await this.context.close();
    }
  }

  async perceive(): Promise<Observation> {
    const url = this.page.url();
    const screenshot = await this.captureScreenshot();
    const body = this.page.locator("body");
    const [ariaSnapshotRaw, visibleTextRaw, landmarkTexts] = await Promise.all([
      body.ariaSnapshot(),
      body.innerText(),
      this.page.locator("h1,h2,h3,h4,button,a[href],label").allInnerTexts(),
    ]);
    const landmarks = [...new Set(landmarkTexts.map((t) => t.trim()).filter(Boolean))].slice(
      0,
      MAX_LANDMARKS,
    );
    return {
      url,
      accessibilitySnapshot: truncate(ariaSnapshotRaw, MAX_ARIA_SNAPSHOT_CHARS),
      visibleText: truncate(visibleTextRaw, MAX_VISIBLE_TEXT_CHARS),
      landmarks,
      screenshot,
    };
  }

  /**
   * Watches for the main frame's NEXT navigation (one that starts after this call) and resolves
   * once it reaches "load" -- i.e. the server has answered and the response page is loaded. If that
   * doesn't happen within `timeoutMs`, or the page/context closes, it resolves with
   * `loaded: false` and the reason; it never rejects. Call it BEFORE the action expected to
   * navigate (so the navigation can't be missed), then await it after the action.
   */
  watchNextNavigation(timeoutMs: number): Promise<NavigationSettle> {
    const startedAt = Date.now();
    const mainFrame = this.page.mainFrame();
    return this.page
      .waitForEvent("framenavigated", { predicate: (frame) => frame === mainFrame, timeout: timeoutMs })
      .then(() => this.page.waitForLoadState("load", { timeout: Math.max(1, timeoutMs - (Date.now() - startedAt)) }))
      .then((): NavigationSettle => ({ loaded: true, ms: Date.now() - startedAt, url: this.page.url() }))
      .catch(
        (err: unknown): NavigationSettle => ({
          loaded: false,
          ms: Date.now() - startedAt,
          url: this.page.isClosed() ? "(page closed)" : this.page.url(),
          reason: err instanceof Error ? err.message.split("\n")[0]! : String(err),
        }),
      );
  }

  private async captureScreenshot(): Promise<Buffer> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.page.screenshot();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= SCREENSHOT_MAX_ATTEMPTS || !TRANSIENT_SCREENSHOT_ERROR.test(message)) throw err;
        this.screenshotRetryCount += 1;
        await new Promise((resolve) => setTimeout(resolve, SCREENSHOT_BACKOFF_MS * attempt));
      }
    }
  }

  async locate(descriptor: ElementDescriptor): Promise<Handle | null> {
    const handle = await resolveDescriptor(this.page, descriptor);
    if (handle) this.recordProvenance(descriptor, handle);
    return handle;
  }

  async act(action: ExecutableAction): Promise<void> {
    switch (action.kind) {
      case "navigate": {
        await this.page.goto(action.url);
        return;
      }
      case "click": {
        const target = requireTarget(action);
        const handle = await this.locate(target);
        assertLiveLocator(handle, target);
        await handle.locator.click();
        return;
      }
      case "type": {
        const target = requireTarget(action);
        const handle = await this.locate(target);
        assertLiveLocator(handle, target);
        await handle.locator.fill(requireValue(action));
        return;
      }
      case "selectOption": {
        const target = requireTarget(action);
        const handle = await this.locate(target);
        assertLiveLocator(handle, target);
        await handle.locator.selectOption(requireValue(action));
        return;
      }
      case "readText": {
        const target = requireTarget(action);
        const handle = await this.locate(target);
        assertLiveLocator(handle, target);
        this.lastReadTextValue = await handle.locator.innerText();
        return;
      }
      case "waitFor": {
        const target = requireTarget(action);
        await this.waitForDescriptor(target, action.timeoutMs ?? DEFAULT_WAIT_FOR_TIMEOUT_MS);
        return;
      }
    }
  }

  // The element targeted by waitFor may not exist in the DOM yet, so unlike the other actions
  // this can't just take locate()'s single-shot result — it has to keep re-resolving until the
  // descriptor matches or the timeout elapses.
  private async waitForDescriptor(target: ElementDescriptor, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let handle: Handle | null = null;
    do {
      handle = await resolveDescriptor(this.page, target);
      if (handle && handle.locator) break;
      await this.page.waitForTimeout(WAIT_FOR_POLL_MS);
    } while (Date.now() < deadline);

    if (!handle || !handle.locator) {
      throw new Error(`waitFor: "${target.describedAs}" did not resolve within ${timeoutMs}ms`);
    }
    await handle.locator.waitFor({ timeout: Math.max(0, deadline - Date.now()) });
    this.recordProvenance(target, handle);
  }

  private recordProvenance(descriptor: ElementDescriptor, handle: Handle): void {
    this.provenanceLog.push({
      descriptor,
      strategy: handle.strategy,
      timestamp: Date.now(),
    });
  }
}
