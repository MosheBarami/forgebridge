import { randomUUID } from 'node:crypto';
import {
  ApplyResult,
  ForgeBridgeError,
  PROTOCOL_VERSION,
  PROTOCOL_VERSION_HEADER,
  ProtocolError,
  type DeliveryEnvelope,
} from '@forgebridge/protocol';
import { PRODUCER_TOKEN_HEADER, deriveSessionKey, openEnvelope, requestMac, sealEnvelope } from '@forgebridge/daemon';
import type { HumanApproval } from '../adapter.js';
import type { FetchLike } from './daemon-adapter.js';

/**
 * The two things the suite needs that a connector must never be able to do:
 * approve a ChangeSet, and be the Roblox Studio session on the other end.
 *
 * They live here, apart from the adapter, and the separation is not tidiness.
 * `apply-after-human-approval` is only worth running if the approval came from
 * somewhere the connector could not reach — an approval the adapter could
 * arrange for itself would prove that apply() works, and nothing about the gate.
 */

export interface DaemonHarnessOptions {
  baseUrl: string;
  producerToken: string;
  fetch?: FetchLike;
  /** Recorded on the approval. Names the stand-in, never a real person. */
  approvedBy?: string;
}

/**
 * A human's approval, as the daemon receives one.
 *
 * It reads the diff first and echoes the `contentDigest` it found there,
 * because that is what an approver does: the digest is what turns "I approve
 * set X" into "I approve the operations I was shown for set X". Computing the
 * digest here from the operations instead would be this harness approving its
 * own idea of the set rather than the one the daemon is holding.
 */
export function daemonHumanApproval(options: DaemonHarnessOptions): HumanApproval {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));
  const headers = (withBody: boolean): Record<string, string> => ({
    accept: 'application/json',
    [PRODUCER_TOKEN_HEADER]: options.producerToken,
    [PROTOCOL_VERSION_HEADER]: PROTOCOL_VERSION,
    ...(withBody ? { 'content-type': 'application/json' } : {}),
  });

  return {
    async approve(changeSetId: string): Promise<void> {
      const diffResponse = await doFetch(`${baseUrl}/v1/changesets/${encodeURIComponent(changeSetId)}/diff`, {
        method: 'GET',
        headers: headers(false),
      });
      const diffText = await diffResponse.text();
      if (!diffResponse.ok) throw await failure(diffResponse.status, diffText, 'read the diff to approve');
      const { contentDigest } = JSON.parse(diffText) as { contentDigest?: string };
      if (!contentDigest) {
        throw new ForgeBridgeError(
          'invalid_request',
          `the diff for ${changeSetId} carries no contentDigest, so there is nothing for an approver to echo`,
        );
      }

      const response = await doFetch(`${baseUrl}/v1/changesets/${encodeURIComponent(changeSetId)}/approve`, {
        method: 'POST',
        headers: headers(true),
        body: JSON.stringify({
          contentDigest,
          approvedBy: options.approvedBy ?? 'conformance-suite (human stand-in)',
          note: 'approved out of band by the conformance harness, never by the connector under test',
        }),
      });
      if (!response.ok) throw await failure(response.status, await response.text(), 'approve');
    },
  };
}

async function failure(status: number, text: string, what: string): Promise<ForgeBridgeError> {
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = null;
  }
  const parsed = ProtocolError.safeParse(body);
  if (parsed.success) return new ForgeBridgeError(parsed.data.code, `could not ${what}: ${parsed.data.message}`, parsed.data.remedy);
  return new ForgeBridgeError('internal', `could not ${what}: the daemon answered ${status}`);
}

export interface StudioDoubleOptions {
  baseUrl: string;
  /**
   * The code the daemon minted. In a real session a person carries this from
   * the daemon's terminal to Studio by hand; here the caller reads it off
   * `daemon.issuePairingCode()` or off the terminal, and it is never fetched.
   */
  pairingCode: string;
  fetch?: FetchLike;
  pluginVersion?: string;
}

export interface DeliveredChangeSet {
  nonce: number;
  changeSetId: string;
  payload: unknown;
}

/**
 * A stand-in for the Roblox Studio plugin, so the suite can be run without
 * Studio.
 *
 * The daemon will not approve a ChangeSet for a project with no paired link —
 * correctly, since an approval that could never be delivered is a lie told to
 * the approver — so something has to be on the consumer end. This pairs, polls
 * and can report an ApplyResult back, using the daemon's own key derivation and
 * envelope sealing rather than a second implementation of either. A second
 * implementation is how a test harness ends up asserting that two bugs agree.
 *
 * It applies nothing. It reports outcomes the caller hands it, which is all a
 * conformance run needs and considerably less than a plugin does.
 */
export interface StudioDouble {
  readonly linkId: string;
  readonly projectId: string;
  /** Wait for the next delivery, or null when the poll window closed empty. */
  poll(signal?: AbortSignal): Promise<DeliveredChangeSet | null>;
  /** Report an apply back, the way the plugin does: enveloped and MAC'd. */
  reportApply(changeSetId: string, outcomes: Array<{ index: number; ok: boolean; error?: string }>, newVersion: number): Promise<void>;
}

export async function connectStudioDouble(options: StudioDoubleOptions): Promise<StudioDouble> {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetch ?? ((input: string, init?: RequestInit) => globalThis.fetch(input, init));

  const paired = await doFetch(`${baseUrl}/v1/link/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ pairingCode: options.pairingCode, pluginVersion: options.pluginVersion ?? '0.1.0-conformance' }),
  });
  const text = await paired.text();
  if (!paired.ok) throw await failure(paired.status, text, 'pair');

  const body = JSON.parse(text) as { linkId: string; projectId: string; sessionSalt: string; since: number };
  const sessionKey = deriveSessionKey(options.pairingCode, Buffer.from(body.sessionSalt, 'base64'), body.linkId);
  let cursor = body.since;
  // The plugin's outbound nonce counter. Monotonic per link: equal counts as a
  // replay, not as a retry.
  let outbound = body.since;

  return {
    linkId: body.linkId,
    projectId: body.projectId,

    async poll(signal): Promise<DeliveredChangeSet | null> {
      const path = '/v1/link/poll';
      const response = await doFetch(`${baseUrl}${path}?since=${cursor}`, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'x-forgebridge-link': body.linkId,
          'x-forgebridge-mac': requestMac(sessionKey, [body.linkId, 'GET', path, String(cursor)]),
        },
        ...(signal ? { signal } : {}),
      });
      if (response.status === 204) return null;
      const raw = await response.text();
      if (!response.ok) throw await failure(response.status, raw, 'poll');

      const opened = openEnvelope(sessionKey, JSON.parse(raw) as DeliveryEnvelope, { linkId: body.linkId });
      cursor = opened.envelope.nonce;
      const payload = opened.payload as { kind?: string; changeSet?: { id?: string } };
      return {
        nonce: opened.envelope.nonce,
        changeSetId: payload.changeSet?.id ?? '',
        payload: opened.payload,
      };
    },

    async reportApply(changeSetId, outcomes, newVersion): Promise<void> {
      const result = ApplyResult.parse({
        changeSetId,
        outcomes,
        newVersion,
        journalId: randomUUID(),
        appliedAt: new Date().toISOString(),
        pluginVersion: options.pluginVersion ?? '0.1.0-conformance',
      });
      outbound += 1;
      const envelope = sealEnvelope(sessionKey, { linkId: body.linkId, nonce: outbound, payload: result });
      const response = await doFetch(`${baseUrl}/v1/changesets/${encodeURIComponent(changeSetId)}/apply-result`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-forgebridge-link': body.linkId },
        body: JSON.stringify(envelope),
      });
      if (!response.ok) throw await failure(response.status, await response.text(), 'report an apply result');
    },
  };
}
