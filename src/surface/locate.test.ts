import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../mock-app/app.js";
import { WebSurface } from "./webSurface.js";

let server: Server;
let baseUrl: string;
let surface: WebSurface;

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;

  surface = await WebSurface.launch({ headless: true });
  await surface.act({ kind: "navigate", url: `${baseUrl}/login` });
  await surface.act({
    kind: "type",
    target: { describedAs: "User ID field", labelText: "User ID" },
    text: "tester",
  });
  await surface.act({
    kind: "type",
    target: { describedAs: "Password field", labelText: "Password" },
    text: "pw",
  });
  await surface.act({
    kind: "click",
    target: { describedAs: "Log In button", role: { role: "button", name: "Log In" } },
  });
}, 30000);

afterAll(async () => {
  await surface.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("locator strategies against the mock app", () => {
  it("resolves the Search button via role+accessibleName", async () => {
    await surface.act({ kind: "navigate", url: `${baseUrl}/` });
    const handle = await surface.locate({
      describedAs: "Search button",
      role: { role: "button", name: "Search" },
    });
    expect(handle?.strategy).toBe("role");
    expect(handle?.locator).not.toBeNull();
  });

  it("resolves the Open Sub-Account button via role+accessibleName", async () => {
    await surface.act({ kind: "navigate", url: `${baseUrl}/member/10001` });
    const handle = await surface.locate({
      describedAs: "Open Sub-Account button",
      role: { role: "button", name: "Open Sub-Account" },
    });
    expect(handle?.strategy).toBe("role");
    expect(handle?.locator).not.toBeNull();
  });

  it("resolves the Member ID input via labelText", async () => {
    await surface.act({ kind: "navigate", url: `${baseUrl}/` });
    const handle = await surface.locate({
      describedAs: "Member ID field",
      labelText: "Member ID",
    });
    expect(handle?.strategy).toBe("labelText");
    expect(handle?.locator).not.toBeNull();
  });

  it("resolves the Current Savings Balance value via tableCell", async () => {
    await surface.act({ kind: "navigate", url: `${baseUrl}/member/10001` });
    const handle = await surface.locate({
      describedAs: "Current Savings Balance value",
      tableCell: { rowLabel: "Current Savings Balance" },
    });
    expect(handle?.strategy).toBe("tableCell");
    expect(handle?.locator).not.toBeNull();
    const text = await handle!.locator!.innerText();
    expect(text).toContain("4532.10");
  });
});
