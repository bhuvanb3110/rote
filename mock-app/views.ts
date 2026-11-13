// HTML rendering for the mock legacy back-office app.
// Deliberately "hostile" markup: nested tables/divs, non-semantic class names, no
// data-testid attributes. Real <label>/<input id> pairs and real button text are kept so
// semantic locators (role + accessible name, label anchors) are POSSIBLE, just not handed
// over as a convenient hook.
import type { LedgerEntry, Member, SubAccountDraft, TransferDraft } from "./data.js";
import { tenantUrl, type TenantConfig } from "./tenants.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Fixed, deterministic "noisy" class names for hostile-mode markup -- stand-ins for what a
// bundler/CSS-in-JS build would emit. NOT randomized per render: an override's css locator
// strategy needs a stable selector to target, and reusing one flat name across fields is fine
// since css uniqueness isn't what's under test here -- DOM structure (isolated wrapper divs) is.
const HZ = { fieldWrap: "zk9f", fieldLbl: "zk9l", fieldCtl: "zk9c", actWrap: "zk9a", actLink: "zk9x", balWrap: "zk9w", balLbl: "zk9y", balVal: "zk9bv" };

/**
 * Renders one form field. Classic mode: today's <label for>/<input id> table row (real
 * association -- labelText resolves). Hostile mode: label text and control live in their OWN
 * isolated wrapper <div> (nothing else inside it) with no <label> element and no id/placeholder
 * on the control -- roleName's name-matching and labelText both cleanly fail (no accessible
 * name, no association), but textAnchor still resolves the control since it's the sole
 * button/a[href]/input/select match inside that div (see locate.ts's tryTextAnchor).
 */
function field(tenant: TenantConfig, label: string, controlHtml: string, forId: string): string {
  if (tenant.hostile) {
    return `<div class="${HZ.fieldWrap}"><div class="${HZ.fieldLbl}">${escapeHtml(label)}</div><div class="${HZ.fieldCtl}">${controlHtml}</div></div>`;
  }
  return `<tr><td><label for="${forId}">${escapeHtml(label)}</label></td><td>${controlHtml}</td></tr>`;
}

/**
 * Renders a form's submit control. Classic mode: a real <button type="submit"> (roleName
 * resolves it directly). Hostile mode: a real <a href="#"> -- NOT a bare <div onclick>, which
 * tryTextAnchor's clickable selector (button, a[href], input, select, [role='button']) wouldn't
 * recognize at all -- styled/labeled identically but with an implicit role of "link," not
 * "button," so roleName cleanly fails while textAnchor still finds it via a[href]. Its own
 * onclick submits the enclosing form (works for both GET and POST forms).
 */
function actionControl(tenant: TenantConfig, label: string): string {
  if (tenant.hostile) {
    return `<div class="${HZ.actWrap}"><a href="#" class="${HZ.actLink}" onclick="this.closest('form').submit();return false;">${escapeHtml(label)}</a></div>`;
  }
  return `<button type="submit">${escapeHtml(label)}</button>`;
}

/**
 * Renders the member's balance. Classic mode: today's <table> row (tableCell resolves it
 * directly). Hostile mode: two sibling <div>s, label and value, with NO <table>/<tr> at all --
 * tableCell requires a tr and cleanly fails (0 matches, not a silently-wrong cell); textAnchor
 * is structurally for CLICKABLES only (see tryTextAnchor), so a non-interactive value can never
 * resolve through it either -- the honest last-resort fallback is `css` on the value's own
 * stable class, exactly as the schema's own comment prescribes ("css only as a last resort").
 */
function balanceBlock(tenant: TenantConfig, rowLabel: string, valueText: string): string {
  if (tenant.hostile) {
    return `<div class="${HZ.balWrap}"><div class="${HZ.balLbl}">${escapeHtml(rowLabel)}</div><div class="${HZ.balVal}">${escapeHtml(valueText)}</div></div>`;
  }
  return `<table class="grid1"><tr><th>${escapeHtml(rowLabel)}</th><td>${escapeHtml(valueText)}</td></tr></table>`;
}

export function layout(tenant: TenantConfig, title: string, body: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { font-family: Tahoma, Arial, sans-serif; font-size: 13px; background: #d6d3ce; margin: 0; }
.wrap1 { width: 760px; margin: 12px auto; background: #fff; border: 1px solid #888; }
.hdr1 { background: #003366; color: #fff; padding: 6px 10px; font-weight: bold; }
.pnl1 { padding: 10px; }
table.grid1 { border-collapse: collapse; width: 100%; }
table.grid1 td, table.grid1 th { border: 1px solid #999; padding: 4px 6px; font-size: 12px; }
table.grid1 th { background: #e8e6df; text-align: left; }
.fld1 { margin-bottom: 8px; }
.fld1 label { display: inline-block; width: 160px; }
.msg1 { padding: 8px; border: 1px solid #999; margin-bottom: 10px; }
.msg1.err { background: #fbe4e4; }
.msg1.ok { background: #e4fbe8; }
</style>
</head>
<body>
<div class="wrap1">
<div class="hdr1">${escapeHtml(tenant.institutionName)} &mdash; Back Office</div>
<div class="pnl1">
${body}
</div>
</div>
</body>
</html>`;
}

export function renderLogin(tenant: TenantConfig, error?: string): string {
  const errBlock = error ? `<div class="msg1 err">${escapeHtml(error)}</div>` : "";
  const fields = [
    field(tenant, "User ID", `<input name="username" type="text"${tenant.hostile ? "" : ' id="f-user"'} />`, "f-user"),
    field(tenant, "Password", `<input name="password" type="password"${tenant.hostile ? "" : ' id="f-pass"'} />`, "f-pass"),
  ].join("");
  const fieldsBlock = tenant.hostile ? fields : `<table class="grid1">${fields}</table>`;
  return layout(
    tenant,
    "Sign In",
    `
${errBlock}
<form method="post" action="${tenantUrl(tenant, "/login")}">
  ${fieldsBlock}
  <p>${actionControl(tenant, "Log In")}</p>
</form>`,
  );
}

export function renderHome(tenant: TenantConfig, username: string): string {
  const fieldHtml = field(
    tenant,
    "Member ID",
    `<input name="id" type="text"${tenant.hostile ? "" : ' id="f-memberid"'} />`,
    "f-memberid",
  );
  const fieldsBlock = tenant.hostile ? fieldHtml : `<table class="grid1">${fieldHtml}</table>`;
  return layout(
    tenant,
    "Member Lookup",
    `
<div>Signed in as ${escapeHtml(username)}</div>
<h3>Member Lookup</h3>
<form method="get" action="${tenantUrl(tenant, "/member/search")}">
  ${fieldsBlock}
  <p>${actionControl(tenant, tenant.searchButtonLabel)}</p>
</form>`,
  );
}

export function renderMemberDetail(tenant: TenantConfig, member: Member): string {
  return layout(
    tenant,
    `Member ${member.id}`,
    `
<h3>Member Detail</h3>
<table class="grid1">
  <tr><th>Member ID</th><td>${escapeHtml(member.id)}</td></tr>
  <tr><th>Name</th><td>${escapeHtml(member.name)}</td></tr>
  <tr><th>Status</th><td>${escapeHtml(member.status)}</td></tr>
</table>
<h4>Accounts</h4>
<table class="grid1">
  <tr><th>Account</th><th>Detail</th></tr>
  <tr>
    <td>Primary Savings</td>
    <td>${balanceBlock(tenant, tenant.balanceLabel, `$${member.savingsBalance.toFixed(2)}`)}</td>
  </tr>
</table>
<form method="get" action="${tenantUrl(tenant, `/member/${encodeURIComponent(member.id)}/sub-account`)}">
  <p>${actionControl(tenant, "Open Sub-Account")}</p>
</form>
<form method="get" action="${tenantUrl(tenant, `/member/${encodeURIComponent(member.id)}/transfer`)}">
  <p>${actionControl(tenant, "Transfer")}</p>
</form>
<form method="get" action="${tenantUrl(tenant, `/member/${encodeURIComponent(member.id)}/history`)}">
  <p>${actionControl(tenant, "History")}</p>
</form>`,
  );
}

export function renderNotFound(tenant: TenantConfig, id: string): string {
  return layout(
    tenant,
    "Record Not Found",
    `
<div class="msg1 err">Record not found for Member ID ${escapeHtml(id)}.</div>
<p><a href="${tenantUrl(tenant, "/")}">Return to Member Lookup</a></p>`,
  );
}

export function renderPermissionDenied(tenant: TenantConfig, id: string): string {
  return layout(
    tenant,
    "Access Denied",
    `
<div class="msg1 err">You do not have permission to view Member ID ${escapeHtml(id)}.</div>
<p><a href="${tenantUrl(tenant, "/")}">Return to Member Lookup</a></p>`,
  );
}

export function renderTransientInterstitial(tenant: TenantConfig, retryPath: string): string {
  return layout(
    tenant,
    "Please Wait",
    `
<div class="msg1 err">System temporarily unavailable, please retry.</div>
<p><a href="${escapeHtml(retryPath)}">Retry</a></p>`,
  );
}

export function renderSubAccountForm(tenant: TenantConfig, memberId: string): string {
  const selectHtml = `<select name="accountType"${tenant.hostile ? "" : ' id="f-accttype"'}>
          <option value="Christmas Club">Christmas Club</option>
          <option value="Holiday Club">Holiday Club</option>
          <option value="Youth Savings">Youth Savings</option>
        </select>`;
  const fields = [
    field(tenant, "Account Type", selectHtml, "f-accttype"),
    field(
      tenant,
      "Initial Deposit",
      `<input name="initialDeposit" type="text"${tenant.hostile ? "" : ' id="f-deposit"'} />`,
      "f-deposit",
    ),
  ].join("");
  const fieldsBlock = tenant.hostile ? fields : `<table class="grid1">${fields}</table>`;
  return layout(
    tenant,
    "Open Sub-Account",
    `
<h3>Open Sub-Account &mdash; Member ${escapeHtml(memberId)}</h3>
<form method="post" action="${tenantUrl(tenant, `/member/${encodeURIComponent(memberId)}/sub-account`)}">
  ${fieldsBlock}
  <p>${actionControl(tenant, "Continue")}</p>
</form>`,
  );
}

export function renderUnexpectedDialog(tenant: TenantConfig, memberId: string): string {
  return layout(
    tenant,
    "Confirm",
    `
<div class="msg1">Are you sure you want to proceed to Open Sub-Account for Member
${escapeHtml(memberId)}?</div>
<p><a href="${tenantUrl(tenant, `/member/${encodeURIComponent(memberId)}/sub-account?ack=1`)}">Proceed</a></p>`,
  );
}

export function renderSubAccountConfirm(
  tenant: TenantConfig,
  memberId: string,
  draft: SubAccountDraft,
): string {
  return layout(
    tenant,
    "Confirm Sub-Account",
    `
<h3>Confirm New Sub-Account &mdash; Member ${escapeHtml(memberId)}</h3>
<table class="grid1">
  <tr><th>Account Type</th><td>${escapeHtml(draft.accountType)}</td></tr>
  <tr><th>Initial Deposit</th><td>$${escapeHtml(draft.initialDeposit)}</td></tr>
</table>
<form method="post" action="${tenantUrl(tenant, `/member/${encodeURIComponent(memberId)}/sub-account/confirm`)}">
  <p>${actionControl(tenant, "Confirm")}</p>
</form>`,
  );
}

export function renderCreated(tenant: TenantConfig, memberId: string): string {
  return layout(
    tenant,
    "Sub-Account Created",
    `
<div class="msg1 ok">Created</div>
<p><a href="${tenantUrl(tenant, `/member/${encodeURIComponent(memberId)}`)}">Return to Member ${escapeHtml(memberId)}</a></p>`,
  );
}

export function renderNoPendingSubAccount(tenant: TenantConfig, memberId: string): string {
  return layout(
    tenant,
    "Confirm Sub-Account",
    `
<div class="msg1 err">No pending sub-account request for Member ${escapeHtml(memberId)}.</div>
<p><a href="${tenantUrl(tenant, `/member/${encodeURIComponent(memberId)}/sub-account`)}">Start Open Sub-Account</a></p>`,
  );
}

export function renderTransferForm(tenant: TenantConfig, memberId: string, error?: string): string {
  const errBlock = error ? `<div class="msg1 err">${escapeHtml(error)}</div>` : "";
  const idAttr = (id: string) => (tenant.hostile ? "" : ` id="${id}"`);
  const fields = [
    field(tenant, "To Member ID", `<input name="toMemberId" type="text"${idAttr("f-tomember")} />`, "f-tomember"),
    field(tenant, "Amount", `<input name="amount" type="text"${idAttr("f-amount")} />`, "f-amount"),
    field(tenant, "Memo", `<input name="memo" type="text"${idAttr("f-memo")} />`, "f-memo"),
  ].join("");
  const fieldsBlock = tenant.hostile ? fields : `<table class="grid1">${fields}</table>`;
  return layout(
    tenant,
    "Transfer",
    `
<h3>Transfer &mdash; Member ${escapeHtml(memberId)}</h3>
${errBlock}
<form method="post" action="${tenantUrl(tenant, `/member/${encodeURIComponent(memberId)}/transfer`)}">
  ${fieldsBlock}
  <p>${actionControl(tenant, "Continue")}</p>
</form>`,
  );
}

export function renderTransferConfirm(tenant: TenantConfig, memberId: string, draft: TransferDraft): string {
  return layout(
    tenant,
    "Confirm Transfer",
    `
<h3>Confirm Transfer &mdash; Member ${escapeHtml(memberId)}</h3>
<table class="grid1">
  <tr><th>To Member ID</th><td>${escapeHtml(draft.toMemberId)}</td></tr>
  <tr><th>Amount</th><td>$${escapeHtml(draft.amount)}</td></tr>
  <tr><th>Memo</th><td>${escapeHtml(draft.memo)}</td></tr>
</table>
<form method="post" action="${tenantUrl(tenant, `/member/${encodeURIComponent(memberId)}/transfer/confirm`)}">
  <p>${actionControl(tenant, "Submit")}</p>
</form>`,
  );
}

/**
 * The reference sits in its own label/value element (a table row, or hostile sibling divs) so a
 * capability's readText can return exactly the TXN id -- see docs/plans/step-03.md, build note 1.
 */
export function renderTransferSubmitted(tenant: TenantConfig, memberId: string, entry: LedgerEntry): string {
  return layout(
    tenant,
    "Transfer Submitted",
    `
<div class="msg1 ok">Transfer Submitted</div>
${balanceBlock(tenant, "Reference", entry.id)}
<p><a href="${tenantUrl(tenant, `/member/${encodeURIComponent(memberId)}`)}">Return to Member ${escapeHtml(memberId)}</a></p>`,
  );
}

export function renderNoPendingTransfer(tenant: TenantConfig, memberId: string): string {
  return layout(
    tenant,
    "Confirm Transfer",
    `
<div class="msg1 err">No pending transfer for Member ${escapeHtml(memberId)}.</div>
<p><a href="${tenantUrl(tenant, `/member/${encodeURIComponent(memberId)}/transfer`)}">Start Transfer</a></p>`,
  );
}

/** The 503 page. Deliberately NOT the transient interstitial's wording ("temporarily unavailable"). */
export function renderSystemUnavailable(tenant: TenantConfig): string {
  return layout(
    tenant,
    "System Unavailable",
    `
<div class="msg1 err">System unavailable. Please try again later.</div>`,
  );
}

export function renderTransferHistory(
  tenant: TenantConfig,
  memberId: string,
  memoFilter: string,
  rows: LedgerEntry[],
): string {
  const filterField = field(
    tenant,
    "Memo",
    `<input name="memo" type="text" value="${escapeHtml(memoFilter)}"${tenant.hostile ? "" : ' id="f-memofilter"'} />`,
    "f-memofilter",
  );
  const filterBlock = tenant.hostile ? filterField : `<table class="grid1">${filterField}</table>`;
  // An empty result is one "No matching transfers." row, as legacy grids do (Step 9): the grid's first
  // body row always exists, so a capability can read its first cell whether or not anything matched.
  const body =
    rows.length === 0
      ? `<tr><td colspan="6">No matching transfers.</td></tr>`
      : rows
          .map(
            (r) =>
              `<tr><td>${escapeHtml(r.id)}</td><td>${escapeHtml(r.at)}</td><td>${escapeHtml(r.fromMemberId)}</td><td>${escapeHtml(r.toMemberId)}</td><td>$${r.amount.toFixed(2)}</td><td>${escapeHtml(r.memo)}</td></tr>`,
          )
          .join("\n  ");
  return layout(
    tenant,
    `Transfer History ${memberId}`,
    `
<h3>Transfer History &mdash; Member ${escapeHtml(memberId)}</h3>
<form method="get" action="${tenantUrl(tenant, `/member/${encodeURIComponent(memberId)}/history`)}">
  ${filterBlock}
  <p>${actionControl(tenant, "Filter")}</p>
</form>
${balanceBlock(tenant, "Matching transfers", String(rows.length))}
<table class="grid1">
  <tr><th>Reference</th><th>Date</th><th>From</th><th>To</th><th>Amount</th><th>Memo</th></tr>
  ${body}
</table>`,
  );
}
