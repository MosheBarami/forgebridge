/**
 * `@forgebridge/sdk-ts` — the TypeScript SDK.
 *
 * A typed client over the `/v1` surface, whose route table and wire schemas are
 * generated from `packages/protocol/schema/openapi.json` rather than written
 * here. The one invariant this package will not smooth over: proposing a
 * ChangeSet and approving one are separate calls, and there is no method that
 * does both (ADR-012).
 *
 * Not published. `packages/sdk-ts` is marked private, so a workspace publish
 * skips it by construction, and there is no `npm install @forgebridge/sdk-ts`
 * that installs it. Whether that marker comes off is `M49`'s to decide — that
 * milestone owns how this repository releases anything. Use it from a checkout.
 */
export {
  ForgeBridgeClient,
  DEFAULT_TIMEOUT_MS,
  OPERATION_COVERAGE,
  buildPath,
  expectRouteAnswersWith,
} from './client.js';
export type { ForgeBridgeClientOptions, RunStreamOptions } from './client.js';

export {
  ForgeBridgeError,
  ForgeBridgeResponseError,
  RouteContractError,
  TransportError,
  describeError,
} from './errors.js';
export type { ErrorCode, ErrorView } from './errors.js';

export { DEFAULT_RUN_IDLE_TIMEOUT_MS, parseEventFrame, readEventStream } from './stream.js';
export type { EventFrame } from './stream.js';

/**
 * There is no `checkChangeSetOrdering` here, and its absence is the point.
 *
 * `packages/sdk-python` has one, because a `.superRefine()` body is arbitrary
 * TypeScript and does not survive the projection into JSON Schema — so a Python
 * producer would otherwise believe a schema-valid ChangeSet is a protocol-valid
 * one. This SDK parses a ChangeSet with the protocol's own Zod schema, which
 * carries the refinement, so `proposeChangeSet` refuses the same set the daemon
 * would. Re-implementing the rule here would add a second copy that can drift
 * from the one it is copying.
 */

/**
 * The generated halves, re-exported whole.
 *
 * `wire.js` carries every `/v1` schema and its inferred type; `routes.js`
 * carries the route table the client is driven by. Both are exported because a
 * caller that wants to build its own request against this protocol should be
 * able to reach the same schemas the client parses with, rather than writing a
 * third copy of them.
 */
export * from './generated/wire.js';
export {
  AUTH_HEADERS,
  OPENAPI_PROTOCOL_VERSION,
  OPERATION_IDS,
  ROUTES,
} from './generated/routes.js';
export type { Auth, OperationId, Route, RouteParameter, RouteResponse } from './generated/routes.js';

export { PROTOCOL_VERSION, PROTOCOL_MAJOR } from '@forgebridge/protocol';
