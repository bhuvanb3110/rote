// Ranked, multi-strategy ElementDescriptor resolver. Never a single brittle CSS selector: tries
// descriptor.strategies in the array's own order (authored/reviewed at discovery time), not a
// hardcoded priority table.
import type { Page, Locator } from "playwright";
import type { ElementDescriptor, Handle, LocatorStrategy } from "./types.js";

type RoleNameStrategy = Extract<LocatorStrategy, { kind: "roleName" }>;
type LabelTextStrategy = Extract<LocatorStrategy, { kind: "labelText" }>;
type TextAnchorStrategy = Extract<LocatorStrategy, { kind: "textAnchor" }>;
type TableCellStrategy = Extract<LocatorStrategy, { kind: "tableCell" }>;
type CssStrategy = Extract<LocatorStrategy, { kind: "css" }>;

async function isUnique(locator: Locator): Promise<boolean> {
  return (await locator.count()) === 1;
}

async function tryRoleName(page: Page, strategy: RoleNameStrategy): Promise<Locator | null> {
  const locator = page.getByRole(strategy.role as Parameters<Page["getByRole"]>[0], {
    name: strategy.name,
  });
  return (await isUnique(locator)) ? locator : null;
}

async function tryLabelText(page: Page, strategy: LabelTextStrategy): Promise<Locator | null> {
  const locator = page.getByLabel(strategy.labelText);
  return (await isUnique(locator)) ? locator : null;
}

// "Nearest clickable to some anchor text": find the anchor text, walk up to its nearest
// row/cell/div/form/list-item container, then look for a unique clickable inside that container.
async function tryTextAnchor(page: Page, strategy: TextAnchorStrategy): Promise<Locator | null> {
  const anchor = page.getByText(strategy.anchorText, { exact: false }).first();
  if ((await anchor.count()) === 0) return null;
  const container = anchor
    .locator("xpath=ancestor::*[self::tr or self::td or self::div or self::form or self::li][1]")
    .first();
  if ((await container.count()) === 0) return null;
  const clickable = container.locator("button, a[href], input, select, [role='button']");
  return (await isUnique(clickable)) ? clickable : null;
}

function exactTextRegExp(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escaped}\\s*$`);
}

// Row matched by header/label text, then column (defaults to the last cell in the row, which
// covers label/value table rows like <tr><th>Current Savings Balance</th><td>4532.10</td></tr>).
// The label cell must be matched by its OWN exact text, not "row contains this text somewhere",
// because a nested table (e.g. a balance table inside an accounts table) would otherwise make
// every ancestor row also "contain" the inner row's text.
async function tryTableCell(page: Page, strategy: TableCellStrategy): Promise<Locator | null> {
  const labelCell = page
    .locator("tr > th, tr > td")
    .filter({ hasText: exactTextRegExp(strategy.rowLabel) });
  if (!(await isUnique(labelCell))) return null;
  const row = labelCell.locator("xpath=ancestor::tr[1]");
  const cells = row.locator("> th, > td");
  const cellCount = await cells.count();
  if (cellCount === 0) return null;
  const index = strategy.column ?? cellCount - 1;
  if (index < 0 || index >= cellCount) return null;
  const cell = cells.nth(index);
  return (await isUnique(cell)) ? cell : null;
}

async function tryCss(page: Page, strategy: CssStrategy): Promise<Locator | null> {
  const locator = page.locator(strategy.css);
  return (await isUnique(locator)) ? locator : null;
}

async function resolveStrategy(page: Page, strategy: LocatorStrategy): Promise<Locator | null> {
  switch (strategy.kind) {
    case "roleName":
      return tryRoleName(page, strategy);
    case "labelText":
      return tryLabelText(page, strategy);
    case "textAnchor":
      return tryTextAnchor(page, strategy);
    case "tableCell":
      return tryTableCell(page, strategy);
    case "css":
      return tryCss(page, strategy);
    case "visual":
      // Never produces a live locator; the guaranteed fallback in resolveDescriptor covers it.
      return null;
  }
}

/**
 * Tries each strategy in descriptor.strategies, in the array's own order, and returns the first
 * one that resolves to exactly one element — uniqueness is load-bearing, so an ambiguous match
 * is treated the same as no match and falls through to the next strategy. Always falls back to
 * a "visual" handle (describedAs carried forward, no live locator) if nothing else resolves,
 * even if the descriptor never explicitly listed a visual strategy — real coordinate-based
 * resolution is future work, but locate() should never leave a caller with nothing at all.
 */
export async function resolveDescriptor(
  page: Page,
  descriptor: ElementDescriptor,
): Promise<Handle | null> {
  for (const strategy of descriptor.strategies) {
    const locator = await resolveStrategy(page, strategy);
    if (locator) {
      return { strategy: strategy.kind, describedAs: descriptor.describedAs, locator };
    }
  }
  return { strategy: "visual", describedAs: descriptor.describedAs, locator: null };
}
