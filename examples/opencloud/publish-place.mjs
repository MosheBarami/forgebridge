/**
 * Publish a place version.
 *
 *   node examples/opencloud/publish-place.mjs <file.rbxl|file.rbxlx> <Saved|Published>
 *
 * Scope: `universe-places:write`.
 *
 * There is no default for the version type, here or in the library. `Saved`
 * writes a version nobody is playing; `Published` makes it live for every
 * player in the universe. A client that picks one when you said nothing has
 * made a production decision on your behalf.
 */
import { readFile } from 'node:fs/promises';
import {
  contentTypeForPlaceFile,
  createOpenCloudClient,
  publishPlaceVersion,
  OpenCloudError,
} from '@forgebridge/opencloud';

const [file, versionType] = process.argv.slice(2);
const apiKey = process.env.ROBLOX_OPEN_CLOUD_API_KEY;
const universeId = process.env.FORGEBRIDGE_UNIVERSE_ID;
const placeId = process.env.FORGEBRIDGE_PLACE_ID;

if (!apiKey || !universeId || !placeId || !file || !versionType) {
  console.error(
    'usage: node examples/opencloud/publish-place.mjs <place file> <Saved|Published>\n' +
      '  ROBLOX_OPEN_CLOUD_API_KEY, FORGEBRIDGE_UNIVERSE_ID and FORGEBRIDGE_PLACE_ID must be set.',
  );
  process.exit(2);
}

// Refuses anything that is not .rbxl or .rbxlx rather than defaulting to
// octet-stream: an unknown extension means we do not know what we are holding.
const { format } = contentTypeForPlaceFile(file);

const client = createOpenCloudClient({ apiKey });

try {
  const { versionNumber } = await publishPlaceVersion(client, {
    universeId,
    placeId,
    file: new Uint8Array(await readFile(file)),
    format,
    versionType,
  });
  console.log(`${versionType} version ${versionNumber} of place ${placeId}.`);
  if (versionType === 'Published') {
    console.log('That is live. Players joining now load it.');
  }
} catch (error) {
  if (error instanceof OpenCloudError) {
    console.error(`\n${error.message}`);
    if (error.kind === 'unreadable' || error.kind === 'transport') {
      // The honest sentence. A publish is not idempotent — a retry makes a
      // second version — so this client never retries one, and never reports
      // an outcome it could not read as a success.
      console.error('Check the version list in Studio before running this again.');
    }
    process.exit(1);
  }
  throw error;
}
