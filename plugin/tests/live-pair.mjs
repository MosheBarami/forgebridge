#!/usr/bin/env node
/*
 * The socket half of the live pairing harness. See tests/live.luau, which holds
 * the Luau half and explains why the two are split: the standalone `luau` CLI
 * has no `io` and no `os.execute`, so it cannot open a socket. This file makes
 * the calls and passes the daemon's real answers in as program arguments.
 *
 * Node is doing transport and assertions ONLY. Every byte of crypto under test
 * is the plugin's own shipping Luau — nothing here reimplements a derivation,
 * because a driver that computed the expected key itself would be marking its
 * own homework and would agree with a plugin that was wrong.
 *
 * The daemon is the judge in both directions: it answers 401 or 200 to a MAC
 * this plugin built, and it seals an envelope this plugin must verify. Each
 * check has a negative control next to it — a corrupted MAC the daemon must
 * refuse, a tampered payload the plugin must refuse — because a check that
 * cannot fail is decoration, which is precisely how M18 sat "done" while the
 * plugin could not pair at all.
 *
 * Not wired into `luau tests/run.luau`: that suite is offline and hermetic, and
 * a test that fails whenever no daemon is running is one people learn to skip.
 *
 * Usage — the daemon prints both values on startup, and the code is single use:
 *
 *   node tests/live-pair.mjs <pairing-code> <producer-token>
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const BASE = process.env.FORGEBRIDGE_BASE_URL ?? 'http://127.0.0.1:7317';
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [, , CODE, TOKEN] = process.argv;
const PROJECT = process.env.FORGEBRIDGE_PROJECT ?? '00000000-0000-4000-8000-000000000001';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

function luau(...args) {
  const out = execFileSync('luau', ['tests/live.luau', '-a', ...args], { cwd: PLUGIN, encoding: 'utf8' });
  const fields = {};
  for (const line of out.trim().split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) fields[line.slice(0, i)] = line.slice(i + 1);
  }
  return fields;
}

async function main() {
  console.log('\n== ForgeBridge M18 — live pairing against 127.0.0.1:7317 ==\n');

  // 1. Redeem the code the daemon printed. Single use: this spends it.
  const pairRes = await fetch(`${BASE}/v1/link/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pairingCode: CODE, projectId: PROJECT, pluginVersion: '0.1.0' }),
  });
  const pair = await pairRes.json();
  check('daemon redeemed the pairing code', pairRes.status === 200, `HTTP ${pairRes.status} ${JSON.stringify(pair).slice(0, 160)}`);
  if (pairRes.status !== 200) return;
  console.log(`       linkId       ${pair.linkId}`);
  console.log(`       daemon keyId ${pair.sessionKeyId}`);
  console.log(`       salt (b64)   ${pair.sessionSalt}`);

  // 2. Luau derives the key from the same code + salt + linkId.
  const d = luau('derive', CODE, pair.linkId, pair.sessionSalt, pair.sessionKeyId, String(pair.since ?? 0));
  check('Pairing.pair accepted the live response', d.PAIR === 'ok', d.PAIR);
  console.log(`       luau keyId   ${d.KEYID}`);
  check('LUAU-DERIVED KEY ID === DAEMON-ISSUED KEY ID', d.KEYID === pair.sessionKeyId,
    d.KEYID === pair.sessionKeyId ? '' : `luau=${d.KEYID} daemon=${pair.sessionKeyId}`);

  // 3. Queue a delivery so the poll returns immediately rather than long-polling.
  const csId = randomUUID();
  const auth = { 'content-type': 'application/json', 'x-forgebridge-token': TOKEN };
  const submitRes = await fetch(`${BASE}/v1/changesets`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({
      id: csId, projectId: PROJECT, baseVersion: 0,
      summary: 'M18 live pairing probe',
      operations: [{ op: 'createInstance', path: 'Workspace.ForgeBridgeM18Probe', className: 'Folder', properties: {} }],
      createdAt: new Date().toISOString(),
    }),
  });
  const submitted = await submitRes.json();
  check('producer submitted a changeset', submitRes.status === 201, `HTTP ${submitRes.status} ${JSON.stringify(submitted).slice(0, 200)}`);
  if (submitRes.status !== 201) return;

  const diffRes = await fetch(`${BASE}/v1/changesets/${csId}/diff`, { headers: { 'x-forgebridge-token': TOKEN } });
  const diff = await diffRes.json();
  const digest = diff.contentDigest ?? diff.diff?.contentDigest;
  check('diff reported a content digest', Boolean(digest), digest ? '' : JSON.stringify(diff).slice(0, 200));

  const approveRes = await fetch(`${BASE}/v1/changesets/${csId}/approve`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ contentDigest: digest, approvedBy: 'm18-live-harness' }),
  });
  const approved = await approveRes.json();
  check('approval enqueued a delivery', approveRes.status === 202, `HTTP ${approveRes.status} ${JSON.stringify(approved).slice(0, 200)}`);

  // 4. THE SERVER-SIDE VERDICT: poll signed with the MAC the Luau code built.
  const pollRes = await fetch(`${BASE}/v1/link/poll?since=${pair.since ?? 0}`, {
    headers: { 'x-forgebridge-link': pair.linkId, 'x-forgebridge-mac': d.POLLMAC },
  });
  const pollBody = await pollRes.text();
  check('DAEMON ACCEPTED THE LUAU-BUILT POLL MAC (not 401)', pollRes.status !== 401,
    `HTTP ${pollRes.status}${pollRes.status === 401 ? ` ${pollBody.slice(0, 200)}` : ''}`);
  if (pollRes.status === 401) return;

  // Control: the same poll with a corrupted MAC must be refused, or the check above proves nothing.
  const badMac = Buffer.from(d.POLLMAC, 'base64');
  badMac[0] ^= 0xff;
  const badRes = await fetch(`${BASE}/v1/link/poll?since=${pair.since ?? 0}`, {
    headers: { 'x-forgebridge-link': pair.linkId, 'x-forgebridge-mac': badMac.toString('base64') },
  });
  check('daemon refused a corrupted MAC (control)', badRes.status === 401, `HTTP ${badRes.status}`);

  // 5. The other direction: Luau verifies the envelope the daemon sealed.
  if (pollRes.status !== 200) {
    check('daemon delivered a sealed envelope', false, `HTTP ${pollRes.status} — no envelope to verify`);
    return;
  }
  const env = JSON.parse(pollBody);
  console.log(`       envelope     nonce=${env.nonce} encrypted=${env.encrypted} mac=${String(env.mac).slice(0, 16)}…`);
  const v = luau('verify', CODE, pair.linkId, pair.sessionSalt, env.linkId, String(env.nonce),
    String(env.encrypted === true), env.mac, env.payload);
  check('LUAU VERIFIED THE DAEMON-SEALED ENVELOPE MAC', v.ENVELOPE === 'ok', v.ENVELOPE);
  check('Luau refused a tampered payload (control)', v.TAMPER === 'refused', v.TAMPER);

  console.log(`\n${failures === 0 ? 'ALL LIVE CHECKS PASSED' : `${failures} LIVE CHECK(S) FAILED`}\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
