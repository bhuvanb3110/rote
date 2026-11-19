// Fake seed data and in-memory stores for the mock legacy back-office app.
// Nothing here is real PII — the whole point is safe-to-commit evidence.

export interface Member {
  id: string;
  name: string;
  status: "Active" | "Closed";
  savingsBalance: number;
}

export const PERMISSION_DENIED_ID = "40404";

const MEMBERS: Member[] = [
  { id: "10001", name: "Alice Johnson", status: "Active", savingsBalance: 4532.1 },
  { id: "10002", name: "Robert Chen", status: "Active", savingsBalance: 812.55 },
  { id: "10003", name: "Maria Alvarez", status: "Closed", savingsBalance: 0 },
];

export function findMember(id: string): Member | undefined {
  return MEMBERS.find((m) => m.id === id);
}

export interface SubAccountDraft {
  accountType: string;
  initialDeposit: string;
}

export interface TransferDraft {
  toMemberId: string;
  /** Normalized dollar amount, e.g. "12.50". */
  amount: string;
  /** Memo exactly as the operator typed it; truncated only when the transfer is submitted. */
  memo: string;
}

export interface Session {
  token: string;
  username: string;
  pendingSubAccount?: { memberId: string; draft: SubAccountDraft };
  pendingTransfer?: { memberId: string; draft: TransferDraft };
}

const sessions = new Map<string, Session>();

export function createSession(username: string): Session {
  const token = `sid_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const session: Session = { token, username };
  sessions.set(token, session);
  return session;
}

export function getSession(token: string | undefined): Session | undefined {
  if (!token) return undefined;
  return sessions.get(token);
}

export function deleteSession(token: string | undefined): void {
  if (!token) return;
  sessions.delete(token);
}

export function setPendingSubAccount(
  session: Session,
  memberId: string,
  draft: SubAccountDraft,
): void {
  session.pendingSubAccount = { memberId, draft };
}

export function clearPendingSubAccount(session: Session): void {
  session.pendingSubAccount = undefined;
}

export function setPendingTransfer(session: Session, memberId: string, draft: TransferDraft): void {
  session.pendingTransfer = { memberId, draft };
}

export function clearPendingTransfer(session: Session): void {
  session.pendingTransfer = undefined;
}

// ---- Ledger -------------------------------------------------------------------------------
// One global in-memory ledger shared by every tenant; each row carries its tenantId and the
// tenant-facing history page shows only the viewing tenant's rows. GET /control/ledger returns
// ALL rows and is the test oracle -- workers never call it (a real bank would not let them).

export interface LedgerEntry {
  /** Bank-assigned transaction id, "TXN-000001"... */
  id: string;
  tenantId: string;
  fromMemberId: string;
  toMemberId: string;
  /** Dollars as a number, two decimals of precision. */
  amount: number;
  /** The memo AS STORED, i.e. already truncated to MEMO_MAX_LENGTH. */
  memo: string;
  /** ISO-8601 timestamp. */
  at: string;
}

const ledger: LedgerEntry[] = [];
let nextTxnNumber = 1;

export function appendLedgerEntry(entry: Omit<LedgerEntry, "id" | "at">): LedgerEntry {
  const row: LedgerEntry = {
    id: `TXN-${String(nextTxnNumber).padStart(6, "0")}`,
    ...entry,
    at: new Date().toISOString(),
  };
  nextTxnNumber += 1;
  ledger.push(row);
  return row;
}

export function allLedgerEntries(): LedgerEntry[] {
  return ledger.map((row) => ({ ...row }));
}

export function resetLedger(): void {
  ledger.length = 0;
  nextTxnNumber = 1;
}
