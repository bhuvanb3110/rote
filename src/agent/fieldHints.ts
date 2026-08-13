// Known field-name hints for the demo app, shared between discover.ts (which must decide
// redaction at the moment evidence is written, before it's too late) and compile.ts (which
// picks a readable parameter name). Sensitivity and naming are separate concerns: the model's
// own `redact` flag on a type/selectOption call is combined with isKnownSensitiveField at
// RECORD time, so evidence and the compiled artifact are never inconsistent with each other --
// there is exactly one place a field is decided to be sensitive, and it happens before the
// first byte reaches disk.
interface FieldHint {
  match: RegExp;
  name: string;
  sensitive: boolean;
}

const FIELD_HINTS: FieldHint[] = [
  { match: /member\s*id/i, name: "memberId", sensitive: false },
  { match: /user\s*id|username/i, name: "username", sensitive: true },
  { match: /password/i, name: "password", sensitive: true },
  { match: /account\s*type/i, name: "accountType", sensitive: false },
  { match: /(initial\s*)?deposit/i, name: "initialDeposit", sensitive: false },
];

export function isKnownSensitiveField(describedAs: string): boolean {
  return FIELD_HINTS.some((h) => h.sensitive && h.match.test(describedAs));
}

export function hintedParamName(describedAs: string): string | undefined {
  return FIELD_HINTS.find((h) => h.match.test(describedAs))?.name;
}
