// Evidence run for the fleet Step 5 queue (docs/plans/step-05.md section 7), against the Postgres in
// docker compose -- not the test database:
//
//   docker compose up -d postgres
//   npm run evidence:queue
//
// 1. Records `docker compose ps`, the health status and the image digest.
// 2. Runs the real migration path (`migrate()` on ROTE_DATABASE_URL, i.e. `npm run db:migrate`).
// 3. In a fresh schema of that database (so dev data is untouched and the run is repeatable), with
//    the REAL dev cap (max_concurrent 2 per tenant):
//    - same-key enqueue: 20 connections x 25 rounds -> one job per round;
//    - the same key in all three tenants -> three jobs (per-tenant keys);
//    - credentials in params -> rejected, 0 rows;
//    - 300 jobs (100 per tenant) drained by 16 concurrent dequeue loops that hold each job 5-15 ms
//      while a sampler polls the per-tenant active count -> every job leased exactly once, the cap
//      never exceeded;
//    - starvation: tenant-a's queued row locked by another transaction -> tenant-b's job.
// 4. A script reads the tables and writes check.txt (RESULT: PASS/FAIL).
//
// Writes evidence/step-05-queue/{check.txt, output.txt, environment.txt}. Exits 1 if any check fails.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { deserializeCapability } from "../src/artifact/index.js";
import {
  CredentialsInParamsError,
  createPool,
  databaseUrlFromEnv,
  dequeue,
  enqueue,
  migrate,
  quoteIdent,
  redactDatabaseUrl,
  type Pool,
} from "../src/queue/index.js";

const OUT = path.join("evidence", "step-05-queue");
const TENANTS = ["tenant-a", "tenant-b", "tenant-c"];
const PARAMS = { memberId: "10001", toMemberId: "10002", amount: "12.34" };

const transcript: string[] = [];
function log(line: string): void {
  transcript.push(line);
  console.log(line);
}

function sh(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, { encoding: "utf8" }).trimEnd();
  } catch (err) {
    return `(failed: ${(err as Error).message})`;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const url = databaseUrlFromEnv();
  const started = new Date().toISOString();

  const environment = [
    `# fleet Step 5 queue evidence, ${started}`,
    `database: ${redactDatabaseUrl(url)}`,
    "",
    "$ docker compose ps",
    sh("docker", ["compose", "ps"]),
    "",
    "$ docker inspect -f {{.State.Health.Status}} rote-postgres-1",
    sh("docker", ["inspect", "-f", "{{.State.Health.Status}}", "rote-postgres-1"]),
    "",
    "$ docker image inspect postgres:17 --format {{index .RepoDigests 0}}",
    sh("docker", ["image", "inspect", "postgres:17", "--format", "{{index .RepoDigests 0}}"]),
  ].join("\n");
  log(environment);

  const checks: Array<[string, boolean]> = [];
  const check = (label: string, ok: boolean) => {
    checks.push([label, ok]);
    log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  };

  // --- 2. the real migration path, on the app database itself ---
  const appPool = createPool({ connectionString: url, max: 2 });
  const appMigrate = await migrate(appPool);
  log(`\n# migrate() on the app database (npm run db:migrate): ${JSON.stringify(appMigrate)}`);
  const appVersions = (await appPool.query("SELECT version FROM schema_migrations ORDER BY 1")).rows.map((r) => r.version);
  check(`app database has 0001_init applied (schema_migrations: ${appVersions.join(", ")})`, appVersions.includes("0001_init"));
  const server = (await appPool.query("SELECT version() AS v")).rows[0].v as string;
  log(`# ${server}`);

  // --- 3. scenarios in a fresh schema of the same database ---
  const schema = `evidence_step05_${Date.now()}`;
  await appPool.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
  const pool: Pool = createPool({ connectionString: url, max: 24, searchPath: schema });
  try {
    const m = await migrate(pool);
    log(`\n# scenario schema ${schema}: migrate() -> ${JSON.stringify(m)}`);
    const caps = (await pool.query("SELECT id, max_concurrent FROM tenants ORDER BY id")).rows;
    log(`# tenants: ${JSON.stringify(caps)}`);
    check("every tenant at the dev cap max_concurrent = 2", caps.length === 3 && caps.every((c) => c.max_concurrent === 2));

    const transfer = deserializeCapability(await readFile("artifacts/transfer.json", "utf8"));

    // 3a. same-key enqueue under concurrency
    const clients = await Promise.all(Array.from({ length: 20 }, () => pool.connect()));
    let roundsOk = 0;
    try {
      for (let round = 0; round < 25; round += 1) {
        const key = `same-key-${round}`;
        const results = await Promise.all(
          clients.map((c) => enqueue(c, { capability: transfer, tenantId: "tenant-a", idempotencyKey: key, params: PARAMS })),
        );
        const rows = (await pool.query("SELECT count(*) AS n FROM jobs WHERE idempotency_key = $1", [key])).rows[0].n;
        if (new Set(results.map((r) => r.job.id)).size === 1 && results.filter((r) => r.created).length === 1 && rows === 1) {
          roundsOk += 1;
        }
      }
    } finally {
      clients.forEach((c) => c.release());
    }
    log(`\n# same-key enqueue: 20 connections x 25 rounds`);
    check(`same key: ${roundsOk}/25 rounds -> exactly 1 job, all 20 callers got its id, exactly one created`, roundsOk === 25);

    // 3b. per-tenant keys
    const perTenant = await Promise.all(
      TENANTS.map((t) => enqueue(pool, { capability: transfer, tenantId: t, idempotencyKey: "shared-across-tenants", params: PARAMS })),
    );
    check(
      `same key in 3 tenants -> ${new Set(perTenant.map((r) => r.job.id)).size} distinct jobs, all created`,
      new Set(perTenant.map((r) => r.job.id)).size === 3 && perTenant.every((r) => r.created),
    );

    // 3c. credentials never stored
    const credErr = await enqueue(pool, {
      capability: transfer,
      tenantId: "tenant-a",
      idempotencyKey: "with-credentials",
      params: { ...PARAMS, username: "operator", password: "operator" },
    }).catch((e: unknown) => e);
    const credRows = (await pool.query("SELECT count(*) AS n FROM jobs WHERE idempotency_key = 'with-credentials' OR params ? 'password' OR params ? 'username'")).rows[0].n;
    check(`credentials in params -> ${(credErr as Error)?.name}, ${credRows} rows stored`, credErr instanceof CredentialsInParamsError && credRows === 0);

    // 3d. 300 jobs, 16 dequeuers, real cap 2
    await pool.query("TRUNCATE jobs, job_attempts RESTART IDENTITY CASCADE");
    for (const t of TENANTS) {
      for (let i = 0; i < 100; i += 1) {
        await enqueue(pool, { capability: transfer, tenantId: t, idempotencyKey: `load-${t}-${i}`, params: PARAMS });
      }
    }
    const maxActive: Record<string, number> = Object.fromEntries(TENANTS.map((t) => [t, 0]));
    let samples = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const { rows } = await pool.query(
          "SELECT tenant_id, count(*) AS n FROM jobs WHERE state IN ('running','committing','verifying') GROUP BY 1",
        );
        for (const r of rows) maxActive[r.tenant_id] = Math.max(maxActive[r.tenant_id]!, r.n);
        samples += 1;
      }
    })();
    const leasedIds: string[] = [];
    let staleCompletions = 0;
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 16 }, async (_, w) => {
        for (;;) {
          const job = await dequeue(pool, { workerId: `evidence-w${w}` });
          if (!job) {
            const left = (await pool.query("SELECT count(*) AS n FROM jobs WHERE state = 'queued'")).rows[0].n;
            if (left === 0) return;
            await sleep(2 + Math.random() * 5); // poll backoff while the caps are full
            continue;
          }
          leasedIds.push(job.id);
          await sleep(5 + Math.random() * 10); // "work" while holding the slot
          const done = await pool.query(
            `UPDATE jobs SET state = 'succeeded', outcome = 'success', lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
             WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3`,
            [job.id, job.fencing_token, `evidence-w${w}`],
          );
          await pool.query("UPDATE job_attempts SET ended_at = now(), outcome = 'success' WHERE job_id = $1 AND fencing_token = $2", [
            job.id,
            job.fencing_token,
          ]);
          if (done.rowCount !== 1) staleCompletions += 1;
        }
      }),
    );
    sampling = false;
    await sampler;
    const elapsed = Date.now() - t0;

    log(`\n# 300 jobs (100 per tenant), 16 dequeue loops, cap 2 per tenant: ${elapsed} ms, ${samples} active-count samples`);
    const states = (await pool.query("SELECT state, fencing_token, attempt, count(*) AS n FROM jobs GROUP BY 1, 2, 3")).rows;
    const attempts = (await pool.query("SELECT count(*) AS n, count(DISTINCT job_id) AS jobs FROM job_attempts")).rows[0];
    const dupAttempts = (await pool.query("SELECT count(*) AS n FROM (SELECT job_id FROM job_attempts GROUP BY 1 HAVING count(*) > 1) d")).rows[0].n;
    log(`# jobs by (state, fencing_token, attempt): ${JSON.stringify(states)}`);
    log(`# job_attempts: ${JSON.stringify(attempts)}; max active per tenant (sampled): ${JSON.stringify(maxActive)}`);
    check(`300 dequeues returned 300 distinct job ids (0 duplicate ids; got ${leasedIds.length} / ${new Set(leasedIds).size})`, leasedIds.length === 300 && new Set(leasedIds).size === 300);
    check(
      "every job succeeded with fencing_token 1 and attempt 1",
      states.length === 1 && states[0].state === "succeeded" && states[0].fencing_token === 1 && states[0].attempt === 1 && states[0].n === 300,
    );
    check(`job_attempts: ${attempts.n} rows for ${attempts.jobs} jobs, ${dupAttempts} jobs with more than one`, attempts.n === 300 && attempts.jobs === 300 && dupAttempts === 0);
    check(`every completion was fenced by its own token (${staleCompletions} stale)`, staleCompletions === 0);
    check(`cap never exceeded: max active per tenant ${JSON.stringify(maxActive)} <= 2 over ${samples} samples`, Object.values(maxActive).every((n) => n <= 2) && samples > 0);
    check("the cap was actually reached (each tenant hit 2 at least once)", Object.values(maxActive).every((n) => n === 2));

    // 3e. starvation fix
    await pool.query("TRUNCATE jobs, job_attempts RESTART IDENTITY CASCADE");
    const a = await enqueue(pool, { capability: transfer, tenantId: "tenant-a", idempotencyKey: "starve-a", params: PARAMS });
    const b = await enqueue(pool, { capability: transfer, tenantId: "tenant-b", idempotencyKey: "starve-b", params: PARAMS });
    const locker = await pool.connect();
    let got: string | undefined;
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE", [a.job.id]);
      got = (await dequeue(pool, { workerId: "starve" }))?.id;
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    check(`starvation: tenant-a's older job row locked by another transaction -> dequeue returned tenant-b's job`, got === b.job.id);
  } finally {
    await pool.end();
    await appPool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
    await appPool.end();
  }

  const allPass = checks.every(([, ok]) => ok);
  const checkText = [
    `# fleet Step 5 queue evidence, ${started} (scripts/evidence-queue.ts)`,
    ...checks.map(([label, ok]) => `${ok ? "PASS" : "FAIL"}  ${label}`),
    "",
    allPass ? "RESULT: PASS" : "RESULT: FAIL",
  ].join("\n");
  log("");
  log(allPass ? "RESULT: PASS" : "RESULT: FAIL");
  await writeFile(path.join(OUT, "environment.txt"), environment + "\n");
  await writeFile(path.join(OUT, "check.txt"), checkText + "\n");
  await writeFile(path.join(OUT, "output.txt"), transcript.join("\n") + "\n");
  if (!allPass) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
