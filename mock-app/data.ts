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

export interface Session {
  token: string;
  username: string;
  pendingSubAccount?: { memberId: string; draft: SubAccountDraft };
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
