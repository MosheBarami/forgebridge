/**
 * Step 2 of 3 — clear a ChangeSet for delivery.
 *
 * A separate file from `propose.mjs`, and separate on purpose. ADR-012 makes
 * approval an act a model does not perform, so the walk-through does not offer a
 * `--yes` flag on the propose step: the two halves are two commands, run by
 * whoever read the diff.
 *
 * The digest is an argument rather than something this script fetches, and that
 * is the mechanism rather than an inconvenience. Reading the diff again here and
 * echoing whatever it said would approve *this script's* idea of the set. Typing
 * the digest that was printed to a person is what turns "I approve set X" into
 * "I approve the operations I was shown for set X" — and if the set changed
 * since, the daemon refuses the approval instead of quietly clearing something
 * nobody read.
 *
 * Run from a checkout, after `npm run build`:
 *
 *   node examples/typescript/approve.mjs <changeSetId> <contentDigest> [--confirm-bulk-delete]
 */
import { ForgeBridgeClient, describeError } from '@forgebridge/sdk-ts';

const [changeSetId, contentDigest, ...flags] = process.argv.slice(2);
const baseUrl = process.env.FORGEBRIDGE_DAEMON_URL ?? 'http://127.0.0.1:7317';
const producerToken = process.env.FORGEBRIDGE_PRODUCER_TOKEN;

if (!changeSetId || !contentDigest) {
  console.error('usage: node examples/typescript/approve.mjs <changeSetId> <contentDigest> [--confirm-bulk-delete]');
  console.error('Both come from `propose.mjs`, which prints the exact command.');
  process.exit(2);
}
if (!producerToken) {
  console.error('Set FORGEBRIDGE_PRODUCER_TOKEN. The daemon prints it once, on the terminal it was started from.');
  process.exit(2);
}

const client = new ForgeBridgeClient({ baseUrl, producerToken });

try {
  const approved = await client.approveChangeSet(changeSetId, {
    contentDigest,
    approvedBy: process.env.USER ?? 'the person at this terminal',
    // A separate flag rather than a bigger button. The daemon requires it when a
    // set removes more instances than the protocol's bulk threshold, so the
    // approver has to say the destructive part out loud.
    confirmBulkDelete: flags.includes('--confirm-bulk-delete'),
  });

  console.log(`approved  : ${approved.changeSetId}`);
  console.log(`status    : ${approved.status}`);
  console.log(`nonce     : ${approved.nonce}`);
  console.log(
    '\nQueued for the paired Studio session. The plugin polls, applies, and reports back;\n' +
      'what it actually did shows up on the journal — see `journal.mjs`.',
  );
} catch (failure) {
  const view = describeError(failure);
  console.error(`[${view.code}] ${view.message ?? 'the approval failed'}`);
  if (view.remedy) console.error(view.remedy);
  if (view.code === 'invalid_request') {
    console.error(
      'A digest that does not match is the gate working: the operations the daemon holds are not the ones\n' +
        'that were printed. Read the diff again before approving.',
    );
  }
  process.exit(1);
}
