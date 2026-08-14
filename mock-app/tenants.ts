// Tenant configuration for the mock app: two variants of the SAME vendor product (same flow,
// same seed members) with different branding/labels and a different path prefix, so a
// Capability recorded against one tenant needs an override to replay correctly against the
// other. TENANT_A's values match this app's original (pre-multi-tenant) behavior exactly, so
// mounting it unprefixed at "/" is a byte-for-byte no-op for every existing artifact/test.
export interface TenantConfig {
  id: string;
  institutionName: string;
  /** "" for the default tenant (mounted at root); a leading-slash prefix for any other tenant. */
  pathPrefix: string;
  cookieName: string;
  /** Accessible name of the Member Lookup page's submit button. */
  searchButtonLabel: string;
  /** Row label above the member's savings balance on the member detail page. */
  balanceLabel: string;
  /**
   * When true, mock-app/views.ts renders every field/button/balance with hostile markup: no
   * ARIA-bearing elements (real <a href> links instead of <button>, defeating roleName), no
   * <label for> association (defeating labelText), and the balance in bare sibling <div>s with
   * no <table> at all (defeating tableCell). Visible TEXT is unchanged from tenant-a -- the
   * point is structural hostility, not relabeling (that's tenant-b's angle).
   */
  hostile: boolean;
}

export const TENANT_A: TenantConfig = {
  id: "tenant-a",
  institutionName: "Great Plains Member Credit Union",
  pathPrefix: "",
  cookieName: "sid",
  searchButtonLabel: "Search",
  balanceLabel: "Current Savings Balance",
  hostile: false,
};

export const TENANT_B: TenantConfig = {
  id: "tenant-b",
  institutionName: "Rolling Hills Credit Union",
  pathPrefix: "/tenant-b",
  cookieName: "sid_tenant_b",
  searchButtonLabel: "Find Member",
  balanceLabel: "Savings Balance",
  hostile: false,
};

export const TENANT_C: TenantConfig = {
  id: "tenant-c",
  institutionName: "Frontier Legacy Credit Union",
  pathPrefix: "/tenant-c",
  cookieName: "sid_tenant_c",
  // Same visible text as tenant-a on purpose -- tenant-c's hostility is purely structural
  // (markup), so any locator failure here is provably NOT a text-matching problem.
  searchButtonLabel: "Search",
  balanceLabel: "Current Savings Balance",
  hostile: true,
};

export const TENANTS: TenantConfig[] = [TENANT_A, TENANT_B, TENANT_C];

/** Prefixes an app-relative path with the tenant's mount point (a no-op for TENANT_A). */
export function tenantUrl(tenant: TenantConfig, path: string): string {
  return `${tenant.pathPrefix}${path}`;
}
