// Minimal Express endpoint over the catalog: GET /capabilities (list) and POST
// /capabilities/:id/invoke (invoke). Same minimal style as src/escalation/console.ts -- no extra
// framework layers, Express is already a dependency. A ReplayResult is returned as-is with 200
// regardless of its own status field: business_outcome/needs_human/failure are normal outcomes
// per CLAUDE.md, not HTTP errors. Only a pre-replay problem (unknown id, invalid params) is an
// HTTP error.
import express, { type Express } from "express";
import { listCapabilities } from "./registry.js";
import { invokeCapability } from "./invoke.js";

export function createCatalogApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/capabilities", async (req, res) => {
    const tenant = typeof req.query.tenant === "string" ? req.query.tenant : undefined;
    const entries = await listCapabilities({ tenant });
    res.json(entries);
  });

  app.post("/capabilities/:id/invoke", async (req, res) => {
    const body = (req.body ?? {}) as {
      params?: Record<string, unknown>;
      tenant?: string;
      entryUrl?: string;
      approveRisky?: boolean;
      approveUnattended?: boolean;
    };
    try {
      const result = await invokeCapability({
        id: req.params.id,
        params: body.params ?? {},
        tenant: body.tenant,
        entryUrl: body.entryUrl,
        approveRisky: body.approveRisky,
        approveUnattended: body.approveUnattended,
      });
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      const status = message.startsWith("No capability with id") ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  return app;
}
