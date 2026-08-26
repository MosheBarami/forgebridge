import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentCard } from '../src/card.js';
import {
  FORGEBRIDGE_SKILLS,
  SKILL_IDS,
  SKILL_INVOCATION_EXTENSION_URI,
  SkillInvocation,
  SKILL_INPUTS,
} from '../src/skills.js';
import { AGENT_CARD_WELL_KNOWN_PATH, AgentCard, A2A_PROTOCOL_VERSION, JSONRPC_BINDING } from '../src/spec.js';
import type { A2AServer } from '../src/server.js';
import { startServer } from './helpers.js';

const running: A2AServer[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

async function serve(): Promise<{ port: number }> {
  const started = await startServer();
  running.push(started.server);
  return { port: started.port };
}

describe('agent card shape', () => {
  const card = buildAgentCard({ endpointUrl: 'https://forgebridge.test/a2a/v1', version: '9.9.9' });

  it('carries every field spec section 4.4.1 marks REQUIRED', () => {
    // Not a re-run of the schema: this names the eight fields explicitly, so
    // that loosening the schema cannot quietly loosen the card.
    expect(card.name).toBeTruthy();
    expect(card.description).toBeTruthy();
    expect(card.supportedInterfaces.length).toBeGreaterThan(0);
    expect(card.version).toBe('9.9.9');
    expect(card.capabilities).toBeDefined();
    expect(card.defaultInputModes.length).toBeGreaterThan(0);
    expect(card.defaultOutputModes.length).toBeGreaterThan(0);
    expect(card.skills.length).toBeGreaterThan(0);
    expect(() => AgentCard.parse(card)).not.toThrow();
  });

  it('declares the JSONRPC interface at the advertised URL and protocol version 1.0', () => {
    const [primary] = card.supportedInterfaces;
    expect(primary?.url).toBe('https://forgebridge.test/a2a/v1');
    expect(primary?.protocolBinding).toBe(JSONRPC_BINDING);
    expect(primary?.protocolVersion).toBe(A2A_PROTOCOL_VERSION);
    // Section 8.3.2: a client echoes `tenant` only when the interface sets it,
    // so an interface that routes on nothing must not carry the field at all.
    expect(primary && 'tenant' in primary).toBe(false);
  });

  it('declares the three optional capabilities as absent rather than omitting them', () => {
    // Section 3.3.4 keys its mandated errors off these flags. A reader of the
    // card must be able to see that streaming will be refused, not infer it.
    expect(card.capabilities.streaming).toBe(false);
    expect(card.capabilities.pushNotifications).toBe(false);
    expect(card.capabilities.extendedAgentCard).toBe(false);
  });

  it('declares the skill-invocation extension as required', () => {
    const extension = card.capabilities.extensions?.find((entry) => entry.uri === SKILL_INVOCATION_EXTENSION_URI);
    expect(extension).toBeDefined();
    expect(extension?.required).toBe(true);
  });

  it('names a security scheme and requires it', () => {
    const schemeNames = Object.keys(card.securitySchemes ?? {});
    expect(schemeNames.length).toBe(1);
    const [name] = schemeNames;
    expect(card.securitySchemes?.[name as string]?.httpAuthSecurityScheme?.scheme).toBe('Bearer');
    expect(Object.keys(card.securityRequirements?.[0]?.schemes ?? {})).toEqual([name]);
  });

  it('lists the six ForgeBridge skills, each with the fields section 4.4.5 requires', () => {
    expect(card.skills.map((skill) => skill.id)).toEqual([...SKILL_IDS]);
    for (const skill of card.skills) {
      expect(skill.id).toBeTruthy();
      expect(skill.name).toBeTruthy();
      expect(skill.description).toBeTruthy();
      expect(skill.tags.length).toBeGreaterThan(0);
    }
  });

  it('says on the card that the two writing skills need an approval the caller cannot grant', () => {
    // The boundary is a discovery-time fact, not a runtime surprise. An
    // orchestrator that reads the card before planning a run must be able to
    // learn this without calling anything.
    for (const id of ['apply-approved-changeset', 'rollback-apply'] as const) {
      const skill = card.skills.find((entry) => entry.id === id);
      expect(skill?.description).toMatch(/approv/i);
      expect(skill?.description).toContain('TASK_STATE_AUTH_REQUIRED');
    }
  });

  it('advertises only examples that are valid invocations', () => {
    // A card whose examples cannot be sent is worse than a card with none: it
    // is a working integration path that fails on first use.
    for (const skill of FORGEBRIDGE_SKILLS) {
      for (const raw of skill.examples ?? []) {
        const envelope = SkillInvocation.parse(JSON.parse(raw));
        expect(envelope.skill).toBe(skill.id);
        expect(() => SKILL_INPUTS[envelope.skill].parse(envelope.input ?? {})).not.toThrow();
      }
    }
  });
});

describe('agent card discovery', () => {
  it('serves the card at the well-known path the spec registers', async () => {
    const { port } = await serve();
    expect(AGENT_CARD_WELL_KNOWN_PATH).toBe('/.well-known/agent-card.json');
    const response = await fetch(`http://127.0.0.1:${port}${AGENT_CARD_WELL_KNOWN_PATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/a2a+json');
    const served = AgentCard.parse(await response.json());
    expect(served.skills.map((skill) => skill.id)).toEqual([...SKILL_IDS]);
  });

  it('does not serve the pre-0.3 /.well-known/agent.json path', async () => {
    // A2A 0.3.0 moved the card and changed its shape. Answering the old path
    // with a 1.0 card would hand a 0.3 client a document it cannot read.
    const { port } = await serve();
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/agent.json`);
    expect(response.status).toBe(404);
  });

  it('is readable without a bearer token', async () => {
    // Section 14.3: the card is public discovery information. Requiring a
    // credential to read it would defeat discovery.
    const { port } = await serve();
    const response = await fetch(`http://127.0.0.1:${port}${AGENT_CARD_WELL_KNOWN_PATH}`);
    expect(response.status).toBe(200);
  });

  it('answers a conditional request with 304 (section 8.6.1)', async () => {
    const { port } = await serve();
    const first = await fetch(`http://127.0.0.1:${port}${AGENT_CARD_WELL_KNOWN_PATH}`);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    expect(first.headers.get('cache-control')).toContain('max-age');

    const second = await fetch(`http://127.0.0.1:${port}${AGENT_CARD_WELL_KNOWN_PATH}`, {
      headers: { 'if-none-match': etag as string },
    });
    expect(second.status).toBe(304);
  });

  it('refuses a write to the card path', async () => {
    const { port } = await serve();
    const response = await fetch(`http://127.0.0.1:${port}${AGENT_CARD_WELL_KNOWN_PATH}`, { method: 'POST' });
    expect(response.status).toBe(405);
  });
});
