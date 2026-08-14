// HTML rendering for the mock legacy back-office app.
// Deliberately "hostile" markup: nested tables/divs, non-semantic class names, no
// data-testid attributes. Real <label>/<input id> pairs and real button text are kept so
// semantic locators (role + accessible name, label anchors) are POSSIBLE, just not handed
// over as a convenient hook.
import type { Member, SubAccountDraft } from "./data.js";
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
