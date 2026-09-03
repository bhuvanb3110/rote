// Demonstrates the catalog as an API surface an AI agent could actually call: real HTTP, not a
// direct function call. Starts the mock app and the catalog server, then runs an "LLM-style"
// loop -- GET /capabilities, pick a tool by name, POST typed args to invoke it -- end to end
// against a real, unmodified capability artifact.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Express } from "express";
import mockApp from "../mock-app/app.js";
import { createCatalogApp, type CatalogEntry } from "../src/catalog/index.js";
import type { ReplayResult } from "../src/artifact/index.js";

// member-lookup.json's target.entryUrlPattern is pinned to this fixed dev port (like every other
// entry point in this repo -- mock-app/index.ts, the CLI's DEFAULT_URL), so the mock app has to
// listen here rather than on an ephemeral port for the real, unmodified artifact to replay
// against it. The catalog server itself has no such constraint and gets an ephemeral port.
const MOCK_APP_PORT = 4100;

async function listen(app: Express, port = 0): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(port, resolve));
  const { port: boundPort } = server.address() as AddressInfo;
  return { server, baseUrl: `http://localhost:${boundPort}` };
}

async function main(): Promise<void> {
  const mock = await listen(mockApp, MOCK_APP_PORT);
  const catalog = await listen(createCatalogApp());
  console.log(`mock app:      ${mock.baseUrl}`);
  console.log(`catalog:       ${catalog.baseUrl}`);

  try {
    // 1. An agent discovers what it can call.
    const listRes = await fetch(`${catalog.baseUrl}/capabilities`);
    const entries = (await listRes.json()) as CatalogEntry[];
    console.log(`\nGET /capabilities -> ${entries.length} capabilities:`);
    for (const entry of entries) console.log(`  - ${entry.id}: ${entry.name} -- ${entry.description}`);

    // 2. It picks one by name, the way a tool-calling LLM would choose from a tool list.
    const chosen = entries.find((entry) => entry.name === "Member Lookup");
    if (!chosen) throw new Error('No capability named "Member Lookup" in the catalog.');
    console.log(`\nchosen tool: ${chosen.id}`);
    console.log(`inputSchema: ${JSON.stringify(chosen.inputSchema)}`);

    // 3. It invokes the tool with typed args matching that schema.
    const invokeRes = await fetch(`${catalog.baseUrl}/capabilities/${chosen.id}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        params: { username: "operator", password: "operator", memberId: "10001" },
        entryUrl: mock.baseUrl,
      }),
    });
    const result = (await invokeRes.json()) as ReplayResult;
    console.log(`\nPOST /capabilities/${chosen.id}/invoke -> status ${invokeRes.status}`);
    console.log(JSON.stringify(result, null, 2));

    if (result.status !== "success") {
      throw new Error(`Expected the demo invocation to succeed, got status "${result.status}".`);
    }
  } finally {
    await Promise.all([
      new Promise<void>((resolve) => mock.server.close(() => resolve())),
      new Promise<void>((resolve) => catalog.server.close(() => resolve())),
    ]);
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
