/**
 * Step 3 of 3 — find out what the apply actually did, and undo it if it was wrong.
 *
 * The journal is where a partial outcome becomes visible. `rollback_partial` is
 * a state of its own and this script prints it as one: some inverses replayed
 * and some did not, so the place is in a state neither the apply nor the
 * rollback describes, and the inverses that would have finished the job are
 * spent. Rounding it up to "rolled back" would tell someone their place is back
 * the way it was when it is not.
 *
 *   node examples/typescript/journal.mjs <journalId>
 *   node examples/typescript/journal.mjs <journalId> --rollback
 *
 * The journal id is reported by the plugin when it applies, and `forgebridge
 * apply` prints it.
 */
import { ForgeBridgeClient, describeError } from '@forgebridge/sdk-ts';

const [journalId, ...flags] = process.argv.slice(2);
const baseUrl = process.env.FORGEBRIDGE_DAEMON_URL ?? 'http://127.0.0.1:7317';
const producerToken = process.env.FORGEBRIDGE_PRODUCER_TOKEN;

if (!journalId) {
  console.error('usage: node examples/typescript/journal.mjs <journalId> [--rollback]');
  process.exit(2);
}
if (!producerToken) {
  console.error('Set FORGEBRIDGE_PRODUCER_TOKEN. The daemon prints it once, on the terminal it was started from.');
  process.exit(2);
}

const client = new ForgeBridgeClient({ baseUrl, producerToken });

/** The five states a journal can be in, in words a reader can act on. */
const MEANING = {
  applied: 'applied, and not reversed',
  rollback_requested: 'a reversal was dispatched; the Studio session has not reported yet',
  rolled_back: 'fully reversed — every inverse replayed',
  rollback_partial: 'PARTIALLY reversed. Some inverses replayed and some did not, and the ones that would have finished the job are spent. The place is in a state neither the apply nor the rollback describes.',
  rollback_failed: 'the reversal was attempted and nothing was undone',
};

try {
  if (flags.includes('--rollback')) {
    const before = await client.getJournal(journalId);
    // `expectedVersion` guards against reversing onto a tree that moved since.
    const dispatched = await client.requestRollback({
      journalId,
      expectedVersion: before.versionAfter,
      reason: 'reverted from the ForgeBridge SDK example',
    });
    console.log(`dispatched: ${dispatched.steps} inverse operation(s), nonce ${dispatched.nonce}`);
    console.log('Dispatched is not done: the Studio session polls for the delivery, replays the inverses,');
    console.log('and reports separately. Re-run this script without --rollback to read the outcome.\n');
  }

  const journal = await client.getJournal(journalId);
  console.log(`journal   : ${journal.journalId}`);
  console.log(`changeset : ${journal.changeSetId}`);
  console.log(`summary   : ${journal.summary}`);
  console.log(`versions  : ${journal.versionBefore} → ${journal.versionAfter}`);
  console.log(`state     : ${journal.state} — ${MEANING[journal.state]}`);
  console.log(
    `inverses  : ${
      journal.inverses === null
        ? 'none held by this daemon. Null is not zero: the inverses never left the Studio session that captured them, so that session may still be able to undo in place, and no other route back exists.'
        : journal.inverses
    }`,
  );

  if (journal.result) {
    // The consumer's own report, verbatim, including the per-inverse failures.
    // A summary is not a record, and the one place someone needs to know which
    // inverse did not replay is the place where the rest of them already have.
    for (const outcome of journal.result.outcomes) {
      console.log(`  inverse ${outcome.index}: ${outcome.ok ? 'ok' : `failed — ${outcome.error ?? 'no reason given'}`}`);
    }
  }
} catch (failure) {
  const view = describeError(failure);
  console.error(`[${view.code}] ${view.message ?? 'the call failed'}`);
  if (view.remedy) console.error(view.remedy);
  process.exit(1);
}
