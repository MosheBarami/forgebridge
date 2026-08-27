/**
 * Round-trip a standard data store entry: write, read back, increment.
 *
 *   node examples/opencloud/datastore.mjs
 *
 * Scopes: `universe-datastores.objects:create`, `:update`, `:read`.
 *
 * The interesting line is the one about verification. `GET …/entry` returns a
 * `content-md5`; when it is present and does not match the body, the library
 * raises instead of returning the value, and when it is absent the value comes
 * back marked unverified. A save file silently truncated in transit and written
 * back on the next tick is worse than an error, and "there was no checksum" is
 * not the same fact as "the checksum was wrong".
 */
import {
  createOpenCloudClient,
  getEntry,
  incrementEntry,
  setEntry,
  OpenCloudError,
} from '@forgebridge/opencloud';

const apiKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
const universeId = process.env.FORGEBRIDGE_UNIVERSE_ID;
const dataStoreName = process.env.FORGEBRIDGE_DATASTORE ?? 'ForgeBridgeExample';
const entryKey = process.env.FORGEBRIDGE_ENTRY_KEY ?? 'example-entry';

if (!apiKey || !universeId) {
  console.error('Set ROBLOX_OPEN_CLOUD_API_KEY and FORGEBRIDGE_UNIVERSE_ID.');
  process.exit(2);
}

const client = createOpenCloudClient({ apiKey });
const address = { universeId, dataStoreName, entryKey };

try {
  const written = await setEntry(client, {
    ...address,
    value: { visits: 1, updatedAt: new Date().toISOString() },
    attributes: { writtenBy: 'forgebridge-example' },
  });
  console.log(`wrote version ${written.version}`);

  const read = await getEntry(client, address);
  console.log('read back  :', JSON.stringify(read.value));
  console.log(`verified   : ${read.metadata.verified ? 'yes — content-md5 matched' : 'no — the service sent no content-md5'}`);
  console.log(`version    : ${read.metadata.version ?? 'not reported'}`);

  // A counter, on its own key. `incrementEntry` is a POST that is emphatically
  // not idempotent: the library never retries it, because a retry after a lost
  // answer increments twice and nothing ever reports that it did.
  const counter = await incrementEntry(client, { ...address, entryKey: `${entryKey}-counter`, incrementBy: 1 });
  console.log(`counter    : ${counter.value}`);
} catch (error) {
  if (error instanceof OpenCloudError) {
    console.error(`\n${error.message}`);
    process.exit(1);
  }
  throw error;
}
