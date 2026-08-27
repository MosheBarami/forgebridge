/**
 * `@forgebridge/opencloud` — Roblox Open Cloud from Node.
 *
 * Three API families, each in its own module with the documentation URL its
 * endpoint shapes were read from at the top of the file:
 *
 *   `places.ts`      publish a place version        `universe-places:write`
 *   `datastores.ts`  standard data stores, v1       `universe-datastores.*`
 *   `messaging.ts`   MessagingService publish       `universe-messaging-service:publish`
 *
 * No runtime dependencies. It is `fetch`, `node:crypto` for the `content-md5`
 * the data store endpoints specify, and hand-written response reading that
 * refuses what it cannot parse.
 *
 * The credential never leaves the process: it is captured in a closure by
 * `createOpenCloudClient`, is not a field on the client, is not in any error
 * message this package raises, and is written to nothing. That is the same rule
 * ADR-006 states for provider keys, applied to the one Roblox issues.
 */
export {
  API_KEY_HEADER,
  DEFAULT_BASE_URL,
  DEFAULT_RETRY,
  buildUrl,
  createOpenCloudClient,
  readJson,
  type OpenCloudClient,
  type OpenCloudClientOptions,
  type OpenCloudResponse,
  type RequestSpec,
  type RetryPolicy,
} from './client.js';

export {
  MAX_DETAIL_LENGTH,
  OpenCloudError,
  parseRetryAfter,
  readErrorEnvelope,
  type OpenCloudErrorInit,
  type OpenCloudErrorKind,
} from './errors.js';

export { assertRobloxId } from './ids.js';

export {
  PLACES_WRITE_SCOPE,
  PLACE_CONTENT_TYPES,
  contentTypeForPlaceFile,
  publishPlaceVersion,
  type PlaceFileFormat,
  type PlaceVersionType,
  type PublishPlaceVersionRequest,
  type PublishPlaceVersionResult,
} from './places.js';

export {
  DATASTORE_SCOPES,
  deleteEntry,
  getEntry,
  getEntryVersion,
  incrementEntry,
  listDataStores,
  listEntries,
  listEntryVersions,
  md5Base64,
  setEntry,
  type DataStoreSummary,
  type EntryAddress,
  type EntryMetadata,
  type EntryResult,
  type EntryVersionSummary,
  type ListPage,
  type SetEntryRequest,
  type SetEntryResult,
} from './datastores.js';

export {
  MAX_MESSAGE_BYTES,
  MAX_MESSAGE_LENGTH,
  MESSAGING_PUBLISH_SCOPE,
  publishMessage,
  type PublishMessageRequest,
} from './messaging.js';

export { API_KEY_ENV, run, type CommandResult } from './bin.js';
