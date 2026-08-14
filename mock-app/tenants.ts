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
}

export const TENANT_A: TenantConfig = {
  id: "tenant-a",
  institutionName: "Great Plains Member Credit Union",
  pathPrefix: "",
  cookieName: "sid",
  searchButtonLabel: "Search",
  balanceLabel: "Current Savings Balance",
};

export const TENANT_B: TenantConfig = {
  id: "tenant-b",
  institutionName: "Rolling Hills Credit Union",
  pathPrefix: "/tenant-b",
  cookieName: "sid_tenant_b",
  searchButtonLabel: "Find Member",
  balanceLabel: "Savings Balance",
};

export const TENANTS: TenantConfig[] = [TENANT_A, TENANT_B];

/** Prefixes an app-relative path with the tenant's mount point (a no-op for TENANT_A). */
export function tenantUrl(tenant: TenantConfig, path: string): string {
  return `${tenant.pathPrefix}${path}`;
}
