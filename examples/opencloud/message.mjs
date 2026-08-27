/**
 * Publish a MessagingService message to a running experience.
 *
 *   node examples/opencloud/message.mjs [topic] [message]
 *
 * Scope: `universe-messaging-service:publish`.
 *
 * A script inside the experience receives it with
 * `MessagingService:SubscribeAsync(topic, handler)`. Nothing arrives if no
 * server is running the place — this endpoint delivers to live servers and does
 * not queue.
 */
import { createOpenCloudClient, publishMessage, MAX_MESSAGE_LENGTH, OpenCloudError } from '@forgebridge/opencloud';

const topic = process.argv[2] ?? 'forgebridge-example';
const message = process.argv[3] ?? JSON.stringify({ at: new Date().toISOString() });
const apiKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
const universeId = process.env.FORGEBRIDGE_UNIVERSE_ID;

if (!apiKey || !universeId) {
  console.error('Set ROBLOX_OPEN_CLOUD_API_KEY and FORGEBRIDGE_UNIVERSE_ID.');
  process.exit(2);
}

const client = createOpenCloudClient({ apiKey });

try {
  await publishMessage(client, { universeId, topic, message });
  console.log(`published ${message.length}/${MAX_MESSAGE_LENGTH} characters to "${topic}"`);
  console.log('Only servers running right now receive it; this endpoint does not queue.');
} catch (error) {
  if (error instanceof OpenCloudError) {
    console.error(`\n${error.message}`);
    process.exit(1);
  }
  // A refusal from the library itself — the ceiling, an empty topic — is a
  // plain Error, and it is a fault in this script's arguments rather than an
  // answer from Roblox. Keeping the two apart is why they are different types.
  console.error(`\n${error.message}`);
  process.exit(2);
}
