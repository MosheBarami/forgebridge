/**
 * MessagingService, from outside the experience.
 *
 * Endpoint, verbatim from
 * https://create.roblox.com/docs/reference/cloud/messaging-service/v1:
 *
 *     POST https://apis.roblox.com/messaging-service/v1/universes/{universeId}/topics/{topic}
 *     x-api-key: <key>
 *     Content-Type: application/json
 *     { "message": "<string>" }
 *
 *     200 (no body)
 *
 * API key scope: `universe-messaging-service:publish`.
 *
 * The documented ceiling is *"the size of the message up to 1,024 characters
 * (1 KB)"*, which names two different limits with one number. This client
 * enforces **both**, before the request leaves: a message may exceed neither
 * 1024 UTF-16 code units nor 1024 UTF-8 bytes. Enforcing only the smaller
 * reading would refuse legitimate messages; enforcing only the larger would let
 * one through for the service to refuse with a message about neither. Checking
 * both refuses exactly what is unsafe under either reading, and says which one
 * was hit.
 */
import type { OpenCloudClient } from './client.js';
import { assertRobloxId } from './ids.js';

/** The scope an API key needs for `publishMessage`. */
export const MESSAGING_PUBLISH_SCOPE = 'universe-messaging-service:publish';

/** Documented as "1,024 characters (1 KB)". Both readings are enforced. */
export const MAX_MESSAGE_LENGTH = 1024;
export const MAX_MESSAGE_BYTES = 1024;

export interface PublishMessageRequest {
  universeId: number | string;
  /** The topic a script inside the experience subscribed to. */
  topic: string;
  /** The payload. A string: the endpoint carries no structure of its own. */
  message: string;
}

export async function publishMessage(client: OpenCloudClient, request: PublishMessageRequest): Promise<void> {
  const universeId = assertRobloxId(request.universeId, 'universeId');

  if (typeof request.topic !== 'string' || request.topic.trim() === '') {
    throw new Error('opencloud: publishMessage needs a non-empty topic');
  }
  if (typeof request.message !== 'string') {
    throw new Error('opencloud: publishMessage needs the message as a string');
  }

  const bytes = new TextEncoder().encode(request.message).byteLength;
  if (request.message.length > MAX_MESSAGE_LENGTH || bytes > MAX_MESSAGE_BYTES) {
    throw new Error(
      `opencloud: the message is ${request.message.length} characters and ${bytes} bytes; ` +
        `MessagingService documents a ceiling of ${MAX_MESSAGE_LENGTH} characters (1 KB) and this client enforces both readings. ` +
        'Send a reference and let the experience fetch the payload.',
    );
  }

  // Encoded here rather than by the caller: a topic is user data and may carry
  // a slash, and an unencoded one would silently address a different path.
  const topic = encodeURIComponent(request.topic);

  await client.send({
    operation: `POST /messaging-service/v1/universes/${universeId}/topics/${topic}`,
    method: 'POST',
    path: `messaging-service/v1/universes/${universeId}/topics/${topic}`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: request.message }),
    // Publishing twice delivers twice. Every subscriber sees both.
    idempotent: false,
  });

  // No body is documented and none is read. The 2xx *is* the answer, and
  // `client.send` has already refused everything that is not one.
}
