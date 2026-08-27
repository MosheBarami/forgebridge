/**
 * The other way a ChangeSet comes into existence: hand the daemon a prompt.
 *
 * A run is on the *propose* side of the approval gate. It returns a ChangeSet
 * stored `validated`, and clearing it is still `approve.mjs` — `StartRunRequest`
 * has no field that reaches approval and none that carries a validation, so a
 * producer cannot send a verdict of its own because there is nowhere to put one.
 *
 * What this script is really for is the attempt list. The router falls back over
 * however many models the policy allows, and every model it tried is reported in
 * order with why it moved on (ADR-008): a fallback the caller cannot see is a
 * silent substitution, and the code in the ChangeSet was written by the model in
 * the last `ok` attempt — which may not be the one that was asked for.
 *
 *   node examples/typescript/run.mjs "add a respawn handler"
 */
import { ForgeBridgeClient, describeError } from '@forgebridge/sdk-ts';

const prompt = process.argv.slice(2).join(' ');
const baseUrl = process.env.FORGEBRIDGE_DAEMON_URL ?? 'http://127.0.0.1:7317';
const producerToken = process.env.FORGEBRIDGE_PRODUCER_TOKEN;

if (!prompt) {
  console.error('usage: node examples/typescript/run.mjs "<prompt>"');
  process.exit(2);
}
if (!producerToken) {
  console.error('Set FORGEBRIDGE_PRODUCER_TOKEN. The daemon prints it once, on the terminal it was started from.');
  process.exit(2);
}

// A run waits on a language model. With a listener the wall-clock ceiling is
// replaced by an idle one, which is the only reading that tells a slow model
// from a dead socket without guessing how long a prompt should take.
const client = new ForgeBridgeClient({ baseUrl, producerToken });

try {
  const response = await client.startRun({ prompt }, (frame) => {
    // Progress goes to stderr so that `| jq` on stdout still works.
    if (frame.name === 'stage') console.error(`… ${JSON.stringify(frame.data)}`);
    if (frame.name === 'model-attempt') console.error(`… ${JSON.stringify(frame.data)}`);
    if (frame.name === 'model-skipped') console.error(`… skipped ${JSON.stringify(frame.data)}`);
  });

  // The whole list, always — success, failure and cancellation alike.
  console.log('models tried, in order:');
  for (const attempt of response.run.attempts) {
    console.log(`  ${attempt.modelId} → ${attempt.outcome}${attempt.note ? ` (${attempt.note})` : ''}`);
  }
  for (const skipped of response.skipped) {
    // Skipped is not attempted, and the two are never merged: a `ModelAttempt`
    // describing a call that never happened would be a record of a fiction.
    console.log(`  ${skipped.modelId} → never invoked (${skipped.reason}: ${skipped.detail})`);
  }

  if (response.changeSetId === null) {
    console.error(`\nthe run produced no ChangeSet: ${response.failure?.message ?? 'no reason given'}`);
    process.exit(1);
  }

  console.log(`\nchangeset : ${response.changeSetId}`);
  console.log(`status    : ${response.changeSetStatus}`);
  console.log(`verdict by: ${response.validation?.computedBy ?? 'nothing computed a verdict'}`);
  console.log(
    `\nNothing has been applied. Read it, then clear it:\n\n` +
      `  node examples/typescript/approve.mjs ${response.changeSetId} ${response.contentDigest}\n`,
  );
} catch (failure) {
  const view = describeError(failure);
  console.error(`[${view.code}] ${view.message ?? 'the run failed'}`);
  if (view.remedy) console.error(view.remedy);
  process.exit(1);
}
