// Minimal operator console: lists the pending intervention request (context + screenshot +
// reason) and exposes "Take control"/"Hand back" as real HTTP calls that flip the
// EscalationController's owner token. No framework, no client-side JS -- a self-refreshing
// server-rendered page is enough for a console whose whole job is "show state, take an action."
import express, { type Express } from "express";
import type { EscalationController } from "./controller.js";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderPage(controller: EscalationController): string {
  const owner = controller.controller;
  const pending = controller.pendingRequest;

  const body =
    owner === "human"
      ? `
        <h2>You have control</h2>
        ${
          pending
            ? `
          <table>
            <tr><th>Capability</th><td>${escapeHtml(pending.capabilityId)} &mdash; ${escapeHtml(pending.goal)}</td></tr>
            <tr><th>Stopped at step</th><td>${escapeHtml(pending.atStepId)}</td></tr>
            <tr><th>URL</th><td>${escapeHtml(pending.url)}</td></tr>
            <tr><th>Reason</th><td>${escapeHtml(pending.reason)}</td></tr>
          </table>
          <p><img src="/screenshot" alt="Screenshot at the moment automation paused" /></p>
        `
            : `<p>No formal intervention request is pending &mdash; control was taken proactively.</p>`
        }
        <p>Operate the SAME browser window the automation was using, then hand back when done.</p>
        <form method="post" action="/hand-back">
          <label for="note">Note (optional)</label><br/>
          <textarea id="note" name="note" rows="3" cols="60"></textarea><br/>
          <button type="submit">Hand back</button>
        </form>
      `
      : `
        <h2>Automation is running</h2>
        <p>Nothing needs you right now. You may take control at any time.</p>
        <form method="post" action="/take-control">
          <button type="submit">Take control</button>
        </form>
      `;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Operator Console</title>
<meta http-equiv="refresh" content="2">
<style>
body { font-family: sans-serif; max-width: 720px; margin: 40px auto; color: #222; }
table { border-collapse: collapse; margin: 12px 0; }
th, td { border: 1px solid #ccc; padding: 4px 10px; text-align: left; font-size: 14px; }
th { background: #f0f0f0; }
img { max-width: 100%; border: 1px solid #999; }
button { padding: 6px 14px; font-size: 14px; }
</style>
</head>
<body>
<h1>Operator Console</h1>
<p>Controller: <strong>${owner}</strong></p>
${body}
</body>
</html>`;
}

export function createOperatorConsole(controller: EscalationController): Express {
  const app = express();
  app.use(express.urlencoded({ extended: true }));

  app.get("/", (_req, res) => {
    res.send(renderPage(controller));
  });

  app.get("/screenshot", (_req, res) => {
    const pending = controller.pendingRequest;
    if (!pending) {
      res.status(404).type("text/plain").send("No pending screenshot.");
      return;
    }
    res.type("image/png").send(pending.screenshot);
  });

  app.post("/take-control", (_req, res) => {
    controller.takeControl();
    res.redirect("/");
  });

  app.post("/hand-back", async (req, res) => {
    const note = typeof req.body.note === "string" && req.body.note.trim() ? req.body.note.trim() : undefined;
    await controller.handBack(note);
    res.redirect("/");
  });

  return app;
}
