// Runnable bootstrap for the mock legacy back-office app; see app.ts for routes/behavior.
import app from "./app.js";

const PORT = Number(process.env.MOCK_APP_PORT ?? 4100);

app.listen(PORT, () => {
  console.log(`mock-app listening on http://localhost:${PORT}`);
});
