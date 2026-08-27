/**
 * Step 1 of 3 — propose a ChangeSet and print the diff a person has to read.
 *
 * This script stops. It does not approve, and it cannot: approving is
 * `approve.mjs`, a separate file, run by a separate person, taking the digest
 * printed below. That separation is ADR-012 made physical — a producer that
 * could approve its own submission would be a model approving its own work — and
 * it is the reason the walk-through is two scripts rather than one with a flag.
 *
 *   FORGEBRIDGE_DAEMON_URL      default http://127.0.0.1:7317
 *   FORGEBRIDGE_BASE_VERSION    default 0 — see the comment on baseVersion below
 *   FORGEBRIDGE_PRODUCER_TOKEN  printed once by `forgebridge daemon`, on its terminal
 *
 * Run from a checkout, after `npm run build`:
 *
 *   node examples/typescript/propose.mjs
 */
import { randomUUID } from 'node:crypto';
import { ForgeBridgeClient, describeError } from '@forgebridge/sdk-ts';

const baseUrl = process.env.FORGEBRIDGE_DAEMON_URL ?? 'http://127.0.0.1:7317';
const producerToken = process.env.FORGEBRIDGE_PRODUCER_TOKEN;

if (!producerToken) {
  console.error(
    'Set FORGEBRIDGE_PRODUCER_TOKEN. The daemon prints it once, on the terminal it was started from —\n' +
      'loopback is not an authentication boundary, so every producer route requires it.',
  );
  process.exit(2);
}

const client = new ForgeBridgeClient({ baseUrl, producerToken });

try {
  // 1. Who are we talking to, and who else can read what we send?
  //
  //    `privacyPosture` is printed verbatim. It is one of the few strings in
  //    this protocol whose *wording* is the contract: rendering it as a padlock
  //    icon would tell the user something false about who can read their code.
  const link = await client.linkStatus();
  console.log(`transport : ${link.transport}`);
  console.log(`privacy   : ${link.privacyPosture}`);
  console.log(`protocol  : ${link.protocolVersion}`);

  const paired = link.links.find((entry) => entry.state === 'paired');
  if (!paired) {
    console.error(
      '\nNo Studio session is paired with this daemon, so an approved ChangeSet would have nowhere to go.\n' +
        'Pair one first: run `forgebridge link` and enter the code in the ForgeBridge plugin.',
    );
    process.exit(1);
  }

  // 2. Propose. Nothing is applied, and nothing is approved.
  //
  //    `baseVersion` is the tree version this set was built against. The daemon
  //    refuses an apply whose base has moved with `stale_base` rather than
  //    merging: there is no last-write-wins path in this protocol.
  //
  //    It is 0 here and overridable by hand because `/v1` publishes no route
  //    that reads a project's current version — the same gap that makes
  //    `tree-read` `unsupported` for every connector in the M31 suite. A fresh
  //    project is at 0; after an apply, the version to build on is the
  //    `newVersion` that apply reported, and the diff below prints
  //    `currentVersion` whenever this guess was wrong.
  const projectId = link.defaultProjectId;
  const baseVersion = Number(process.env.FORGEBRIDGE_BASE_VERSION ?? 0);
  const submitted = await client.proposeChangeSet({
    id: randomUUID(),
    projectId,
    baseVersion,
    summary: 'example: add a respawn handler',
    operations: [
      {
        op: 'writeScript',
        path: 'ServerScriptService.RespawnHandler',
        scriptType: 'Script',
        source: [
          'local Players = game:GetService("Players")',
          '',
          'Players.PlayerAdded:Connect(function(player)',
          '\tplayer.CharacterAdded:Connect(function(character)',
          '\t\tlocal humanoid = character:WaitForChild("Humanoid")',
          '\t\thumanoid.Died:Connect(function()',
          '\t\t\ttask.wait(3)',
          '\t\t\tplayer:LoadCharacter()',
          '\t\tend)',
          '\tend)',
          'end)',
          '',
        ].join('\n'),
      },
    ],
    createdAt: new Date().toISOString(),
  });

  console.log(`\nchangeset : ${submitted.changeSetId}`);
  console.log(`status    : ${submitted.status}`);
  console.log(`luau      : ${submitted.validation.luau.status}`);
  console.log(`policy    : ${submitted.validation.policy.status}`);
  console.log(`verdict by: ${submitted.validation.computedBy}`);

  // 3. Read the diff. This is the thing a person reads before approving, and
  //    `contentDigest` is what binds their approval to what they read.
  const diff = await client.getDiff(submitted.changeSetId);
  if (diff.stale) {
    console.error(
      `\nThis set was built on version ${diff.baseVersion} and the project is at ${diff.currentVersion}. ` +
        `It will be refused with stale_base.\nRe-run with FORGEBRIDGE_BASE_VERSION=${diff.currentVersion}.`,
    );
    process.exit(1);
  }

  console.log(`\n${diff.summary}`);
  console.log(
    `${diff.counts.total} operation(s), ${diff.counts.scripts} of which install Luau ` +
      `(a cross-cut of the others, not another slice — so these do not sum to the total)`,
  );
  for (const operation of diff.operations) {
    console.log(`  [${operation.index}] ${operation.op} ${operation.paths.join(' → ')}${operation.destructive ? '  DESTRUCTIVE' : ''}`);
    if (operation.after) {
      for (const line of operation.after.split('\n')) console.log(`      | ${line}`);
    }
  }

  console.log(
    [
      '',
      'Nothing has been applied and nothing has been approved. Read the code above.',
      'If a person is satisfied with it, they clear it — from Roblox Studio, from',
      '`forgebridge apply`, or with:',
      '',
      `  node examples/typescript/approve.mjs ${diff.changeSetId} ${diff.contentDigest}`,
      '',
    ].join('\n'),
  );
} catch (failure) {
  const view = describeError(failure);
  console.error(`\n[${view.code}] ${view.message ?? 'the call failed'}`);
  if (view.remedy) console.error(view.remedy);
  if (!view.recognised) console.error('(nothing recognisable answered — this is not a decision the daemon made)');
  process.exit(1);
}
