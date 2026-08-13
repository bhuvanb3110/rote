import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { resolveDescriptor } from "./locate.js";
import type {
  Action,
  ElementDescriptor,
  Handle,
  LocatorProvenanceEntry,
  Observation,
  Surface,
} from "./types.js";

export interface WebSurfaceOptions {
  /** Defaults to false (headed) — human handoff needs a real window to take over in. */
  headless?: boolean;
}

const MAX_ARIA_SNAPSHOT_CHARS = 4000;
const MAX_VISIBLE_TEXT_CHARS = 2000;
const MAX_LANDMARKS = 40;
const WAIT_FOR_POLL_MS = 150;
const DEFAULT_WAIT_FOR_TIMEOUT_MS = 5000;

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

/** WebSurface (Playwright/Chromium) — the only concrete Surface implementation for now. */
export class WebSurface implements Surface {
  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly page: Page;
  private readonly provenanceLog: LocatorProvenanceEntry[] = [];
  private lastReadTextValue: string | null = null;

  private constructor(browser: Browser, context: BrowserContext, page: Page) {
    this.browser = browser;
    this.context = context;
    this.page = page;
  }

  static async launch(options: WebSurfaceOptions = {}): Promise<WebSurface> {
    const browser = await chromium.launch({ headless: options.headless ?? false });
    const context = await browser.newContext();
    const page = await context.newPage();
    return new WebSurface(browser, context, page);
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

  async close(): Promise<void> {
    await this.browser.close();
  }

  async perceive(): Promise<Observation> {
    const url = this.page.url();
    const screenshot = await this.page.screenshot();
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

  async locate(descriptor: ElementDescriptor): Promise<Handle | null> {
    const handle = await resolveDescriptor(this.page, descriptor);
    if (handle) this.recordProvenance(descriptor, handle);
    return handle;
  }

  async act(action: Action): Promise<void> {
    switch (action.kind) {
      case "navigate": {
        await this.page.goto(action.url);
        return;
      }
      case "click": {
        const handle = await this.locate(action.target);
        assertLiveLocator(handle, action.target);
        await handle.locator.click();
        return;
      }
      case "type": {
        const handle = await this.locate(action.target);
        assertLiveLocator(handle, action.target);
        await handle.locator.fill(action.text);
        return;
      }
      case "selectOption": {
        const handle = await this.locate(action.target);
        assertLiveLocator(handle, action.target);
        await handle.locator.selectOption(action.value);
        return;
      }
      case "readText": {
        const handle = await this.locate(action.target);
        assertLiveLocator(handle, action.target);
        this.lastReadTextValue = await handle.locator.innerText();
        return;
      }
      case "waitFor": {
        await this.waitForDescriptor(action.target, action.timeoutMs ?? DEFAULT_WAIT_FOR_TIMEOUT_MS);
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
