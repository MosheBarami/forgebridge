/**
 * Place publishing.
 *
 * Endpoint, verbatim from
 * https://create.roblox.com/docs/cloud/guides/usage-place-publishing and
 * https://create.roblox.com/docs/reference/cloud/universes-api:
 *
 *     POST https://apis.roblox.com/universes/v1/{universeId}/places/{placeId}/versions?versionType=Published
 *     x-api-key: <key>
 *     Content-Type: application/xml            (an .rbxlx file)
 *                or application/octet-stream   (an .rbxl file)
 *     <the place file, as the raw request body>
 *
 *     200 { "versionNumber": 7 }
 *
 * API key scope: `universe-places:write`.
 *
 * Two things this module refuses to decide for the caller, and the reason is
 * the same both times — a wrong guess here is silent and expensive.
 *
 * **`versionType` has no default.** "Saved" writes a version nobody is playing;
 * "Published" makes it live for every player in the universe. Those are not
 * variations of one action, and a client that picks one when the caller said
 * nothing has made a production decision on their behalf.
 *
 * **The content type is not sniffed from the bytes.** An `.rbxlx` is XML and an
 * `.rbxl` is binary, they take different `Content-Type` values, and the caller
 * knows which they have. `contentTypeForPlaceFile` will map a *filename* for
 * you and refuses any extension that is not one of the two, rather than
 * defaulting to octet-stream and letting the service reject a file the client
 * mislabelled.
 */
import type { OpenCloudClient } from './client.js';
import { readJson } from './client.js';
import { OpenCloudError } from './errors.js';
import { assertRobloxId } from './ids.js';

/** The scope an API key needs for `publishPlaceVersion`. */
export const PLACES_WRITE_SCOPE = 'universe-places:write';

export type PlaceVersionType = 'Published' | 'Saved';

export type PlaceFileFormat = 'rbxl' | 'rbxlx';

export const PLACE_CONTENT_TYPES: Readonly<Record<PlaceFileFormat, string>> = {
  rbxl: 'application/octet-stream',
  rbxlx: 'application/xml',
};

export interface PublishPlaceVersionRequest {
  universeId: number | string;
  placeId: number | string;
  /** The place file's bytes. Not a path: this package does no file I/O. */
  file: Uint8Array;
  format: PlaceFileFormat;
  /** No default. See the note in this file's header. */
  versionType: PlaceVersionType;
}

export interface PublishPlaceVersionResult {
  versionNumber: number;
}

/**
 * Map a place filename onto its `Content-Type`, or refuse.
 *
 * Refuses rather than defaults, for the reason in the header: an unknown
 * extension means this client does not know what it is holding, and
 * "octet-stream, probably" is a guess dressed as a decision.
 */
export function contentTypeForPlaceFile(filename: string): { format: PlaceFileFormat; contentType: string } {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.rbxlx')) return { format: 'rbxlx', contentType: PLACE_CONTENT_TYPES.rbxlx };
  if (lower.endsWith('.rbxl')) return { format: 'rbxl', contentType: PLACE_CONTENT_TYPES.rbxl };
  throw new Error(
    `opencloud: "${filename}" is neither .rbxl nor .rbxlx, and those are the two formats the place publishing endpoint documents. ` +
      'Name the format explicitly if the file is correct and the extension is not.',
  );
}

export async function publishPlaceVersion(
  client: OpenCloudClient,
  request: PublishPlaceVersionRequest,
): Promise<PublishPlaceVersionResult> {
  const universeId = assertRobloxId(request.universeId, 'universeId');
  const placeId = assertRobloxId(request.placeId, 'placeId');
  if (!(request.file instanceof Uint8Array)) {
    throw new Error('opencloud: publishPlaceVersion needs the place file as a Uint8Array');
  }
  if (request.file.byteLength === 0) {
    // A zero-byte place is never what someone meant, and the service's own
    // refusal for it is not self-explanatory.
    throw new Error('opencloud: refusing to publish a zero-byte place file');
  }
  const contentType = PLACE_CONTENT_TYPES[request.format];
  if (contentType === undefined) {
    throw new Error(`opencloud: format must be "rbxl" or "rbxlx" (got "${String(request.format)}")`);
  }
  if (request.versionType !== 'Published' && request.versionType !== 'Saved') {
    throw new Error(
      `opencloud: versionType must be "Published" or "Saved" (got "${String(request.versionType)}"). ` +
        'There is no default: "Saved" writes a version nobody is playing and "Published" makes it live.',
    );
  }

  const operation = `POST /universes/v1/${universeId}/places/${placeId}/versions`;
  const response = await client.send({
    operation,
    method: 'POST',
    path: `universes/v1/${universeId}/places/${placeId}/versions`,
    query: { versionType: request.versionType },
    headers: { 'content-type': contentType },
    // The upload is the body verbatim, not multipart and not base64.
    body: request.file,
    // A second publish of the same bytes creates a *second version*. That is
    // not idempotent, so a lost answer is reported rather than repeated.
    idempotent: false,
  });

  const body = readJson(response, operation);
  const versionNumber = readVersionNumber(body);
  if (versionNumber === undefined) {
    throw new OpenCloudError({
      kind: 'unreadable',
      operation,
      status: response.status,
      detail:
        'the response carried no integer "versionNumber". The place may or may not have been published; ' +
        'check the version list in Studio rather than trusting this call either way',
    });
  }
  return { versionNumber };
}

/**
 * The documented field is `versionNumber`, and the usage guide shows it as a
 * number while the reference describes the value as a string. Both are accepted
 * and normalised to a number; anything else is not, because a `versionNumber`
 * this client cannot read is a publish this client cannot confirm.
 */
function readVersionNumber(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const raw = (body as Record<string, unknown>)['versionNumber'];
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) return Number(raw.trim());
  return undefined;
}
