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
    target: {
      describedAs: "User ID field",
      strategies: [{ kind: "labelText", labelText: "User ID", confidence: 0.9 }],
    },
    value: "tester",
  });
  await surface.act({
    kind: "type",
    target: {
      describedAs: "Password field",
      strategies: [{ kind: "labelText", labelText: "Password", confidence: 0.9 }],
    },
    value: "pw",
  });
  await surface.act({
    kind: "click",
    target: {
      describedAs: "Log In button",
      strategies: [{ kind: "roleName", role: "button", name: "Log In", confidence: 0.95 }],
    },
  });
}, 30000);

afterAll(async () => {
  await surface.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("locator strategies against the mock app", () => {
  it("resolves the Search button via roleName+accessibleName", async () => {
    await surface.act({ kind: "navigate", url: `${baseUrl}/` });
    const handle = await surface.locate({
      describedAs: "Search button",
      strategies: [{ kind: "roleName", role: "button", name: "Search", confidence: 0.95 }],
    });
    expect(handle?.strategy).toBe("roleName");
    expect(handle?.locator).not.toBeNull();
  });

  it("resolves the Open Sub-Account button via roleName+accessibleName", async () => {
    await surface.act({ kind: "navigate", url: `${baseUrl}/member/10001` });
    const handle = await surface.locate({
      describedAs: "Open Sub-Account button",
      strategies: [
        { kind: "roleName", role: "button", name: "Open Sub-Account", confidence: 0.95 },
      ],
    });
    expect(handle?.strategy).toBe("roleName");
    expect(handle?.locator).not.toBeNull();
  });

  it("resolves the Member ID input via labelText", async () => {
    await surface.act({ kind: "navigate", url: `${baseUrl}/` });
    const handle = await surface.locate({
      describedAs: "Member ID field",
      strategies: [{ kind: "labelText", labelText: "Member ID", confidence: 0.9 }],
    });
    expect(handle?.strategy).toBe("labelText");
    expect(handle?.locator).not.toBeNull();
  });

  it("resolves the Current Savings Balance value via tableCell", async () => {
    await surface.act({ kind: "navigate", url: `${baseUrl}/member/10001` });
    const handle = await surface.locate({
      describedAs: "Current Savings Balance value",
      strategies: [
        { kind: "tableCell", rowLabel: "Current Savings Balance", confidence: 0.85 },
      ],
    });
    expect(handle?.strategy).toBe("tableCell");
    expect(handle?.locator).not.toBeNull();
    const text = await handle!.locator!.innerText();
    expect(text).toContain("4532.10");
  });
});
