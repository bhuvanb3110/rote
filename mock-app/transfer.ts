// Transfer rules for the mock bank: input validation and the memo truncation policy.
import { findMember, type Member } from "./data.js";

/** The bank silently truncates memos to this many characters on submit (see docs/DECISIONS.md D5). */
export const MEMO_MAX_LENGTH = 64;

export function truncateMemo(memo: string): string {
  // Count code points, not UTF-16 units, so an emoji is never cut in half.
  return Array.from(memo).slice(0, MEMO_MAX_LENGTH).join("");
}

export interface ValidTransfer {
  ok: true;
  toMemberId: string;
  /** Normalized to two decimals, e.g. "12.50". */
  amount: string;
  memo: string;
}

export interface InvalidTransfer {
  ok: false;
  /** Visible error text. The first words are what capabilities match on. */
  error: string;
}

const AMOUNT_PATTERN = /^\d{1,9}(?:\.\d{1,2})?$/;

/**
 * Validates a transfer from `from` against the SEEDED balances (balances are never debited; see
 * the Step 2 decisions). Order matters because each message is a distinct known outcome.
 */
export function validateTransfer(
  from: Member,
  input: { toMemberId: string; amount: string; memo: string },
): ValidTransfer | InvalidTransfer {
  const toMemberId = input.toMemberId.trim();
  const rawAmount = input.amount.trim().replace(/^\$/, "");
  if (from.status !== "Active") {
    return { ok: false, error: `Source member ${from.id} is closed.` };
  }
  if (!toMemberId) return { ok: false, error: "To Member ID is required." };
  if (!rawAmount) return { ok: false, error: "Amount is required." };
  if (!AMOUNT_PATTERN.test(rawAmount) || Number(rawAmount) <= 0) {
    return { ok: false, error: "Amount must be a positive dollar amount with at most two decimals." };
  }
  const to = findMember(toMemberId);
  if (!to) return { ok: false, error: `Recipient not found: Member ID ${toMemberId}.` };
  if (to.id === from.id) return { ok: false, error: "Cannot transfer to the same member." };
  if (to.status !== "Active") return { ok: false, error: `Recipient ${to.id} is closed.` };
  const amount = Number(rawAmount);
  if (amount > from.savingsBalance) {
    return { ok: false, error: "Insufficient funds for this transfer." };
  }
  return { ok: true, toMemberId: to.id, amount: amount.toFixed(2), memo: input.memo };
}
