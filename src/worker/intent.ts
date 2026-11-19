// T3: the commit intent (docs/plans/step-08.md section 3). Written inside onIrreversible.before, i.e.
// right before the irreversible click (seam 1, D11), as ONE transaction:
//
//   UPDATE jobs  running -> committing, commit_intent_at = now(), a full lease (click + settle <= 10 s)
//                WHERE token, owner, state = 'running' AND lease_expires_at > now()
//   0 rows   ROLLBACK and throw FencingError: the click never happens (runReplay rejects with it).
//   UPDATE job_attempts SET commit_intent_at = now() for this (job, token)
//   COMMIT
//
// The UPDATE ... WHERE confirms lease and token and sets the state in one atomic step: under READ
// COMMITTED Postgres locks the row first and re-evaluates the WHERE on the locked row, so a concurrent
// recovery (which bumps the token) either committed first (0 rows here) or waits for this one.
//
// ONLY A SUCCESSFUL COMMIT LETS THE CLICK HAPPEN. If the COMMIT fails or its result is unknown (the
// connection dropped mid-commit) this throws that error and the hook throws: no click. If the intent did
// commit after all, the job sits in `committing` with no click; its lease expires and recovery handles
// it (Step 8: needs_human; Step 9: verify finds 0 matches and resubmits). Safe either way. The caller
// (runJob) treats such an error as "the intent may have been written" (irreversibleStarted), and only
// a FencingError as "definitely not written".
import { withTransaction, type Pool } from "../queue/index.js";
import { FencingError } from "./leaseErrors.js";

export const COMMIT_INTENT_SQL = `
UPDATE jobs
SET state = 'committing', commit_intent_at = now(),
    lease_expires_at = now() + make_interval(secs => $4),
    updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3
  AND state = 'running' AND lease_expires_at > now()
RETURNING commit_intent_at`;

export const STAMP_ATTEMPT_INTENT_SQL = `
UPDATE job_attempts SET commit_intent_at = now()
WHERE job_id = $1 AND fencing_token = $2`;

export interface CommitIntentArgs {
  jobId: string;
  fencingToken: number;
  workerId: string;
  /** The lease T3 grants for click + settle (the worker's lease length). */
  leaseSeconds: number;
}

/** T3. Resolves with commit_intent_at once COMMITTED; FencingError when this worker is not the live holder. */
export async function writeCommitIntent(pool: Pool, args: CommitIntentArgs): Promise<Date> {
  return withTransaction(pool, async (client) => {
    const updated = await client.query<{ commit_intent_at: Date }>(COMMIT_INTENT_SQL, [
      args.jobId,
      args.fencingToken,
      args.workerId,
      args.leaseSeconds,
    ]);
    if (updated.rowCount !== 1) {
      throw new FencingError(
        `commit intent refused for job ${args.jobId}: token ${args.fencingToken} / owner ${args.workerId} no longer holds a ` +
          "live lease on a running job (recovered, or the lease expired); the Submit was NOT clicked",
        { jobId: args.jobId, fencingToken: args.fencingToken, workerId: args.workerId },
      );
    }
    await client.query(STAMP_ATTEMPT_INTENT_SQL, [args.jobId, args.fencingToken]);
    return updated.rows[0]!.commit_intent_at;
  });
}
