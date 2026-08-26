import { createRequire } from 'node:module';
import { FORGEBRIDGE_SKILLS, SKILL_INVOCATION_EXTENSION_URI } from './skills.js';
import {
  A2A_PROTOCOL_VERSION,
  AgentCard,
  JSONRPC_BINDING,
  type AgentCard as AgentCardType,
} from './spec.js';

/**
 * The Agent Card (§4.4.1), served at `/.well-known/agent-card.json` (§8.2).
 *
 * The card is the only thing a stranger reads before deciding whether to talk
 * to this agent, so two things are said on it that a card could get away with
 * omitting.
 *
 * First, the capabilities are declared honestly as *absent*. `streaming`,
 * `pushNotifications` and `extendedAgentCard` are all false, which is not a
 * cosmetic admission: §3.3.4 makes an undeclared capability a hard error, so
 * `SubscribeToTask` and the push-notification methods are refused with the
 * specific errors the specification names for exactly this case. Declaring a
 * capability this connector does not implement would turn a clean refusal into
 * a hang.
 *
 * Second, the approval boundary is on the card, in the description of the
 * skills that carry it. An orchestrator planning a run should be able to learn
 * at discovery time that apply requires an approval it cannot issue, rather
 * than discovering it after it has already built a ChangeSet and expected to
 * finish the job.
 */

/**
 * Read from this package's manifest rather than duplicated as a literal, for
 * the reason `DAEMON_VERSION` gives: a hand-copied version is a version that
 * goes stale, and `AgentCard.version` is what a client caches against (§8.6.1).
 */
export const A2A_CONNECTOR_VERSION: string = (
  createRequire(import.meta.url)('../package.json') as { version: string }
).version;

/** The repository. Used as the provider URL and as the documentation root. */
export const FORGEBRIDGE_REPOSITORY_URL = 'https://github.com/MosheBarami/forgebridge' as const;

export interface AgentCardOptions {
  /**
   * The absolute URL at which this connector's JSON-RPC endpoint is reachable
   * by the agents that will call it.
   *
   * Required, and deliberately not derived from the listening socket: an agent
   * card is a public document, and a card that advertised `http://127.0.0.1:…`
   * because that is what the process bound would be advertising an address no
   * caller can use. §4.4.6 requires an absolute HTTPS URL in production.
   */
  endpointUrl: string;
  /** Overrides the manifest version. For tests, and for a downstream repackager. */
  version?: string;
  /**
   * An opaque routing identifier, when several ForgeBridge instances sit behind
   * one A2A endpoint (§4.4.6 `tenant`). §8.3.2 requires a client that selects
   * this interface to echo the value in every request, so it is only set when
   * an operator actually routes on it.
   */
  tenant?: string;
  /**
   * The name of the security scheme callers authenticate with, and the scheme
   * itself. Defaults to HTTP bearer, which is what `server.ts` checks.
   */
  securitySchemeName?: string;
}

const DEFAULT_SECURITY_SCHEME_NAME = 'forgebridgeBearer';

export function buildAgentCard(options: AgentCardOptions): AgentCardType {
  const schemeName = options.securitySchemeName ?? DEFAULT_SECURITY_SCHEME_NAME;

  const card: AgentCardType = {
    name: 'ForgeBridge',
    description:
      'A bridge between any AI model or agent and Roblox Studio. Propose edits to a Roblox place as a validated ' +
      'ChangeSet, read the rendered diff, apply an approved ChangeSet to the paired Studio session, roll a previous ' +
      'apply back from its journal, query the routable model catalog, and check the Studio link. Writes are ' +
      'approval-gated: a calling agent may propose and read, and a human must approve before anything reaches the ' +
      'place.',
    supportedInterfaces: [
      {
        url: options.endpointUrl,
        protocolBinding: JSONRPC_BINDING,
        ...(options.tenant ? { tenant: options.tenant } : {}),
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    provider: {
      organization: 'ForgeBridge',
      url: FORGEBRIDGE_REPOSITORY_URL,
    },
    version: options.version ?? A2A_CONNECTOR_VERSION,
    documentationUrl: `${FORGEBRIDGE_REPOSITORY_URL}/tree/main/packages/a2a`,
    capabilities: {
      // All three absent, and said out loud rather than omitted: §3.3.4 keys
      // its mandated errors off these flags, so a reader of this card knows
      // precisely which methods will refuse it and why.
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        {
          uri: SKILL_INVOCATION_EXTENSION_URI,
          description:
            'ForgeBridge skill invocation. A2A has no skill-invocation mechanism, so a caller names the skill it ' +
            'wants in exactly one data Part shaped { "skill": <skill id>, "input": { ... } }. Required, because a ' +
            'message that names no skill cannot be acted on: ForgeBridge will not infer an intent to write into a ' +
            "user's Roblox place from prose.",
          required: true,
        },
      ],
    },
    securitySchemes: {
      [schemeName]: {
        httpAuthSecurityScheme: {
          description:
            'A bearer token issued by the operator of this ForgeBridge instance. It authenticates the calling ' +
            'agent; it does not authorise applying a ChangeSet, which needs a separate human approval.',
          scheme: 'Bearer',
        },
      },
    },
    securityRequirements: [{ schemes: { [schemeName]: { list: [] } } }],
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json', 'text/plain'],
    skills: [...FORGEBRIDGE_SKILLS],
  };

  // Parsed against the schema transcribed from the proto rather than trusted:
  // the card is the contract a stranger reads, and a card this connector serves
  // but could not itself have accepted is a bug that would only ever be found
  // by whoever tried to integrate.
  //
  // TODO(M31): the connector conformance suite should validate this card
  // against the published A2A JSON Schema rather than against `spec.ts`, which
  // is this package's own transcription and can therefore only catch drift from
  // itself. Owner: the conformance-suite author.
  return AgentCard.parse(card);
}

/**
 * §8.6.1: an `ETag` "derived from the Agent Card's `version` field or a hash of
 * the card content". The version is used, because it is the thing that actually
 * changes when the card does and it makes a conditional request answerable
 * without re-rendering.
 */
export function agentCardEtag(card: AgentCardType): string {
  return `"${card.version}"`;
}
