// Ranked, multi-strategy ElementDescriptor resolver. Never a single brittle CSS selector.
import type { Page, Locator } from "playwright";
import type { ElementDescriptor, Handle, LocatorStrategy } from "./types.js";

async function isUnique(locator: Locator): Promise<boolean> {
  return (await locator.count()) === 1;
}

async function tryRole(page: Page, descriptor: ElementDescriptor): Promise<Locator | null> {
  if (!descriptor.role) return null;
  const locator = page.getByRole(descriptor.role.role as Parameters<Page["getByRole"]>[0], {
    name: descriptor.role.name,
  });
  return (await isUnique(locator)) ? locator : null;
}

async function tryLabelText(page: Page, descriptor: ElementDescriptor): Promise<Locator | null> {
  if (!descriptor.labelText) return null;
  const locator = page.getByLabel(descriptor.labelText);
  return (await isUnique(locator)) ? locator : null;
}

// "Nearest clickable to some anchor text": find the anchor text, walk up to its nearest
// row/cell/div/form/list-item container, then look for a unique clickable inside that container.
async function tryTextAnchor(page: Page, descriptor: ElementDescriptor): Promise<Locator | null> {
  if (!descriptor.textAnchor) return null;
  const anchor = page.getByText(descriptor.textAnchor.anchorText, { exact: false }).first();
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
async function tryTableCell(page: Page, descriptor: ElementDescriptor): Promise<Locator | null> {
  if (!descriptor.tableCell) return null;
  const { rowLabel, column } = descriptor.tableCell;
  const labelCell = page
    .locator("tr > th, tr > td")
    .filter({ hasText: exactTextRegExp(rowLabel) });
  if (!(await isUnique(labelCell))) return null;
  const row = labelCell.locator("xpath=ancestor::tr[1]");
  const cells = row.locator("> th, > td");
  const cellCount = await cells.count();
  if (cellCount === 0) return null;
  const index = column ?? cellCount - 1;
  if (index < 0 || index >= cellCount) return null;
  const cell = cells.nth(index);
  return (await isUnique(cell)) ? cell : null;
}

async function tryCss(page: Page, descriptor: ElementDescriptor): Promise<Locator | null> {
  if (!descriptor.css) return null;
  const locator = page.locator(descriptor.css);
  return (await isUnique(locator)) ? locator : null;
}

const STRATEGIES: Array<{
  name: LocatorStrategy;
  resolve: (page: Page, descriptor: ElementDescriptor) => Promise<Locator | null>;
}> = [
  { name: "role", resolve: tryRole },
  { name: "labelText", resolve: tryLabelText },
  { name: "textAnchor", resolve: tryTextAnchor },
  { name: "tableCell", resolve: tryTableCell },
  { name: "css", resolve: tryCss },
];

/**
 * Tries each strategy the descriptor has fields for, in priority order, and returns the first
 * one that resolves to exactly one element — uniqueness is load-bearing, so an ambiguous match
 * is treated the same as no match and falls through to the next strategy. Falls back to the
 * "visual" strategy, a documented stub that carries the human description forward with no live
 * locator; real coordinate-based resolution is future work.
 */
export async function resolveDescriptor(
  page: Page,
  descriptor: ElementDescriptor,
): Promise<Handle | null> {
  for (const strategy of STRATEGIES) {
    const locator = await strategy.resolve(page, descriptor);
    if (locator) {
      return { strategy: strategy.name, describedAs: descriptor.describedAs, locator };
    }
  }
  return { strategy: "visual", describedAs: descriptor.describedAs, locator: null };
}
