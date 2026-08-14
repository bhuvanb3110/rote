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
  return layout(
    tenant,
    "Sign In",
    `
${errBlock}
<form method="post" action="${tenantUrl(tenant, "/login")}">
  <table class="grid1">
    <tr>
      <td><label for="f-user">User ID</label></td>
      <td><input id="f-user" name="username" type="text" /></td>
    </tr>
    <tr>
      <td><label for="f-pass">Password</label></td>
      <td><input id="f-pass" name="password" type="password" /></td>
    </tr>
  </table>
  <p><button type="submit">Log In</button></p>
</form>`,
  );
}

export function renderHome(tenant: TenantConfig, username: string): string {
  return layout(
    tenant,
    "Member Lookup",
    `
<div>Signed in as ${escapeHtml(username)}</div>
<h3>Member Lookup</h3>
<form method="get" action="${tenantUrl(tenant, "/member/search")}">
  <table class="grid1">
    <tr>
      <td><label for="f-memberid">Member ID</label></td>
      <td><input id="f-memberid" name="id" type="text" /></td>
    </tr>
  </table>
  <p><button type="submit">${escapeHtml(tenant.searchButtonLabel)}</button></p>
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
    <td>
      <table class="grid1">
        <tr><th>${escapeHtml(tenant.balanceLabel)}</th><td>$${member.savingsBalance.toFixed(2)}</td></tr>
      </table>
    </td>
  </tr>
</table>
<form method="get" action="${tenantUrl(tenant, `/member/${encodeURIComponent(member.id)}/sub-account`)}">
  <p><button type="submit">Open Sub-Account</button></p>
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
  return layout(
    tenant,
    "Open Sub-Account",
    `
<h3>Open Sub-Account &mdash; Member ${escapeHtml(memberId)}</h3>
<form method="post" action="${tenantUrl(tenant, `/member/${encodeURIComponent(memberId)}/sub-account`)}">
  <table class="grid1">
    <tr>
      <td><label for="f-accttype">Account Type</label></td>
      <td>
        <select id="f-accttype" name="accountType">
          <option value="Christmas Club">Christmas Club</option>
          <option value="Holiday Club">Holiday Club</option>
          <option value="Youth Savings">Youth Savings</option>
        </select>
      </td>
    </tr>
    <tr>
      <td><label for="f-deposit">Initial Deposit</label></td>
      <td><input id="f-deposit" name="initialDeposit" type="text" /></td>
    </tr>
  </table>
  <p><button type="submit">Continue</button></p>
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
  <p><button type="submit">Confirm</button></p>
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
