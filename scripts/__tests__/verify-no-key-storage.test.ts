import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  blankNonCode,
  credentialAllowance,
  credentialArguments,
  credentialMarker,
  findDeclarations,
  findSinkCalls,
  isCredentialShaped,
  isPersistenceModule,
  isStoreSeam,
  scanKeyCustody,
  segmentIdentifier,
  verifyNoKeyStorage,
} from '../verify-no-key-storage.js';

/**
 * Promise 4 says the no-server-side-key-storage claim is "checked by a test, not
 * by a promise". A gate that has never been shown to fail is a promise wearing a
 * test's clothes, so every rule below gets a planted violation as well as a
 * clean case. Fixtures are built in a temp tree; the real repository is only
 * ever read.
 */

let root: string;

function write(rel: string, contents: string): void {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, contents);
}

function rules(): string[] {
  return verifyNoKeyStorage(root).map((violation) => violation.rule);
}

/**
 * A minimal tree with a real store seam: a persistence module, a `…Store`
 * interface, and a record it writes. Every fixture below is this plus one
 * mistake.
 */
function cleanTree(): void {
  write(
    'packages/core/src/ports/storage.ts',
    [
      'export interface ProjectRecord {',
      '  id: string;',
      '  name: string;',
      '}',
      'export interface ProjectStore {',
      '  get(id: string): Promise<ProjectRecord | null>;',
      '  create(project: ProjectRecord): Promise<void>;',
      '}',
      'export interface StoragePort {',
      '  projects: ProjectStore;',
      '}',
    ].join('\n'),
  );
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'fb-keys-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ── Naming ───────────────────────────────────────────────────────────────────

describe('segmentIdentifier', () => {
  it('splits camelCase, snake_case and SCREAMING_CASE alike', () => {
    expect(segmentIdentifier('sessionKeyId')).toEqual(['session', 'key', 'id']);
    expect(segmentIdentifier('api_key')).toEqual(['api', 'key']);
    expect(segmentIdentifier('API_KEY')).toEqual(['api', 'key']);
    expect(segmentIdentifier('OpenRouterAPIKey')).toEqual(['open', 'router', 'api', 'key']);
  });
});

describe('credential naming', () => {
  it('recognises every pattern the gate is written against', () => {
    for (const name of [
      'apiKey', 'api_key', 'API_KEY', 'secret', 'clientSecret', 'token', 'authToken',
      'password', 'credential', 'credentials', 'accessKey', 'privateKey', 'bearer',
      'bearerToken', 'sessionKey', 'providerKey', 'keyMaterial',
    ]) {
      expect(isCredentialShaped(name), name).toBe(true);
    }
  });

  it('an identifier for a key is not a key — the sessionKeyId rule', () => {
    // The distinction Promise 4 lives or dies on: Link stores this on purpose.
    expect(isCredentialShaped('sessionKeyId')).toBe(false);
    expect(credentialMarker('sessionKeyId')).not.toBeNull();
    expect(credentialAllowance('sessionKeyId')).toContain('trailing "id"');

    for (const name of ['apiKeyId', 'secretName', 'credentialRef', 'apiKeyHash', 'tokenScope', 'secretBackend']) {
      expect(isCredentialShaped(name), name).toBe(false);
    }
  });

  it('a claim about a credential is not a credential', () => {
    for (const name of ['hasApiKey', 'isTokenRequired', 'redactedToken', 'requiresCredential']) {
      expect(isCredentialShaped(name), name).toBe(false);
    }
  });

  it('an LLM token count is not a bearer token', () => {
    // Every one of these is a real field in packages/protocol or model-registry.
    for (const name of ['promptTokens', 'completionTokens', 'contextTokens', 'maxCompletionTokens', 'minContextTokens']) {
      expect(isCredentialShaped(name), name).toBe(false);
    }
    // …but the exemption is qualifier-gated, so a bare bag of tokens still trips.
    expect(isCredentialShaped('tokens')).toBe(true);
  });

  it('does not over-match ordinary names containing "key"', () => {
    for (const name of ['cacheKey', 'keyBy', 'sortKey', 'keyring', 'primaryKeyColumn', 'monkey']) {
      expect(isCredentialShaped(name), name).toBe(false);
    }
  });
});

// ── Lexing ───────────────────────────────────────────────────────────────────

describe('blankNonCode', () => {
  it('blanks comments and string bodies but keeps offsets and lines', () => {
    const source = "const a = 'apiKey'; // apiKey\nconst b = 1;";
    const blanked = blankNonCode(source);
    expect(blanked).toHaveLength(source.length);
    expect(blanked.split('\n')).toHaveLength(2);
    expect(blanked).not.toContain('apiKey');
  });

  it('keeps template interpolations live — that is where a key gets logged', () => {
    const blanked = blankNonCode('const m = `provider key ${apiKey} failed`;');
    expect(blanked).toContain('apiKey');
    expect(blanked).not.toContain('provider key');
  });

  it('does not let braces inside a regex desync the scanner', () => {
    const source = [
      'export const Row = z.object({',
      '  code: z.string().regex(/^[a-z]{3}$/),',
      '  apiKey: z.string(),',
      '});',
    ].join('\n');
    const [declaration] = findDeclarations(source, 'packages/x/src/store.ts');
    expect(declaration?.fields.map((field) => field.name)).toEqual(['code', 'apiKey']);
  });
});

// ── Declarations ─────────────────────────────────────────────────────────────

describe('findDeclarations', () => {
  it('finds interfaces, object type literals, zod objects and zod composites', () => {
    const source = [
      'export interface A { one: string }',
      'export type B = { two: string };',
      'export const C = z.object({ three: z.string() });',
      "export const D = z.discriminatedUnion('kind', [z.object({ four: z.string() })]);",
    ].join('\n');
    const found = findDeclarations(source, 'packages/x/src/types.ts');
    expect(found.map((declaration) => declaration.name).sort()).toEqual(['A', 'B', 'C', 'D']);
    expect(found.find((declaration) => declaration.name === 'D')?.fields.map((f) => f.name)).toEqual(['four']);
  });

  it('finds SQL columns and skips table constraints', () => {
    const source = [
      'create table provider (',
      '  id text primary key,',
      '  api_key text not null,',
      '  unique (id)',
      ');',
    ].join('\n');
    const [table] = findDeclarations(source, 'packages/db/schema.sql');
    expect(table?.kind).toBe('table');
    expect(table?.fields.map((field) => field.name)).toEqual(['id', 'api_key']);
  });

  it('reads a quoted key but not a commented-out one', () => {
    const source = [
      'export const Row = z.object({',
      "  'api_key': z.string(),",
      '  // secret: z.string(),',
      '});',
    ].join('\n');
    const [declaration] = findDeclarations(source, 'packages/x/src/store.ts');
    expect(declaration?.fields.map((field) => field.name)).toEqual(['api_key']);
  });
});

describe('scope predicates', () => {
  it('knows a persistence module and a store seam when it sees one', () => {
    expect(isPersistenceModule('packages/core/src/ports/storage.ts')).toBe(true);
    expect(isPersistenceModule('packages/daemon/src/store.ts')).toBe(true);
    expect(isPersistenceModule('packages/x/migrations/001-init.sql')).toBe(true);
    expect(isPersistenceModule('packages/daemon/src/pairing.ts')).toBe(false);
    expect(isStoreSeam('ChangeSetStore')).toBe(true);
    expect(isStoreSeam('StoragePort')).toBe(true);
    expect(isStoreSeam('Store')).toBe(false);
    expect(isStoreSeam('TransportPort')).toBe(false);
  });
});

// ── Sinks ────────────────────────────────────────────────────────────────────

describe('findSinkCalls', () => {
  it('classifies disk, database, response, log and telemetry calls', () => {
    const source = [
      'writeFileSync(p, x);',
      'db.query(sql);',
      'writeJson(res, 200, body);',
      'console.log(x);',
      'span.setAttributes(a);',
      'store.putLink(link);',
    ].join('\n');
    expect(findSinkCalls(source).map((call) => call.kind)).toEqual([
      'disk', 'database', 'response', 'log', 'telemetry', 'database',
    ]);
  });

  it('ignores a method declaration, which looks exactly like a call', () => {
    const source = 'export interface TelemetryPort {\n  counter(name: string, value: number): void;\n}';
    expect(findSinkCalls(source, findDeclarations(source, 'packages/core/src/ports/telemetry.ts'))).toEqual([]);
  });

  it('ignores an in-memory keyring write — a Map is not a store', () => {
    // packages/daemon does exactly this, and it must stay legal.
    expect(findSinkCalls('this.keyring.set(linkId, sessionKey);')).toEqual([]);
  });
});

describe('credentialArguments', () => {
  it('reads identifiers, not prose', () => {
    expect(credentialArguments(blankNonCode("'the secret is safe'"))).toEqual([]);
    expect(credentialArguments(blankNonCode('{ apiKey: provider.apiKey }'))).toEqual(['apiKey']);
    expect(credentialArguments(blankNonCode('{ sessionKeyId }'))).toEqual([]);
  });
});

// ── K1 ───────────────────────────────────────────────────────────────────────

describe('K1 — no persisted shape declares a credential-shaped field', () => {
  it('passes on a tree whose stored shapes hold no credential', () => {
    cleanTree();
    expect(verifyNoKeyStorage(root)).toEqual([]);
  });

  it('flags a credential field on a record declared in a persistence module', () => {
    cleanTree();
    write(
      'packages/core/src/ports/storage.ts',
      'export interface ProjectRecord {\n  id: string;\n  apiKey: string;\n}\n',
    );
    expect(rules()).toContain('K1');
  });

  it('flags a credential field on a shape a store seam merely names', () => {
    // The shape lives in an ordinary module; only the seam's signature drags it in.
    cleanTree();
    write('packages/core/src/profile.ts', 'export interface ProviderProfile {\n  slug: string;\n  apiKey: string;\n}\n');
    write(
      'packages/core/src/ports/storage.ts',
      [
        'import type { ProviderProfile } from "../profile.js";',
        'export interface ProjectStore {',
        '  attach(profile: ProviderProfile): Promise<void>;',
        '}',
      ].join('\n'),
    );
    const violation = verifyNoKeyStorage(root).find((candidate) => candidate.rule === 'K1');
    expect(violation?.file).toBe('packages/core/src/profile.ts:3');
    expect(violation?.detail).toContain('ProviderProfile.apiKey');
  });

  it('follows a reference one type deep — a credential is often not on the record itself', () => {
    cleanTree();
    write(
      'packages/core/src/ports/storage.ts',
      [
        'import type { AuthBlob } from "../auth.js";',
        'export interface ProjectRecord {',
        '  id: string;',
        '  auth: AuthBlob;',
        '}',
        'export interface ProjectStore {',
        '  create(project: ProjectRecord): Promise<void>;',
        '}',
      ].join('\n'),
    );
    write('packages/core/src/auth.ts', 'export interface AuthBlob {\n  accessKey: string;\n}\n');
    expect(rules()).toContain('K1');
  });

  it('flags a zod schema and a SQL column, not only an interface', () => {
    cleanTree();
    write(
      'packages/storage-sqlite/src/schema.ts',
      'export const StoredProvider = z.object({\n  slug: z.string(),\n  apiKey: z.string(),\n});\n',
    );
    expect(rules()).toContain('K1');

    rmSync(path.join(root, 'packages/storage-sqlite'), { recursive: true, force: true });
    write(
      'packages/storage-sqlite/migrations/001-init.sql',
      'create table provider (\n  id text primary key,\n  api_key text not null\n);\n',
    );
    expect(rules()).toContain('K1');
  });

  it('leaves a transient credential alone — the RedeemedPairing case', () => {
    // A real key in a real field, returned into an in-process keyring and never
    // stored. Flagging it would be the false positive that gets the gate muted.
    cleanTree();
    write(
      'packages/daemon/src/pairing.ts',
      'export interface RedeemedPairing {\n  sessionKey: Buffer;\n  sessionKeyId: string;\n}\n',
    );
    expect(verifyNoKeyStorage(root)).toEqual([]);
  });

  it('leaves an identifier and a token count alone inside a persisted shape', () => {
    cleanTree();
    write(
      'packages/core/src/ports/storage.ts',
      [
        'export interface ProjectRecord {',
        '  id: string;',
        '  sessionKeyId: string | null;',
        '  promptTokens: number;',
        '  // apiKey: string;',
        '}',
        'export interface ProjectStore {',
        '  create(project: ProjectRecord): Promise<void>;',
        '}',
      ].join('\n'),
    );
    expect(verifyNoKeyStorage(root)).toEqual([]);
  });
});

// ── K2 ───────────────────────────────────────────────────────────────────────

describe('K2 — no StoragePort method accepts or returns a credential', () => {
  it('flags a credential parameter on a store method', () => {
    cleanTree();
    write(
      'packages/core/src/ports/storage.ts',
      'export interface SettingsStore {\n  setApiKey(scope: string, apiKey: string): Promise<void>;\n}\n',
    );
    expect(rules()).toContain('K2');
  });

  it('flags a credential-shaped return type', () => {
    cleanTree();
    write(
      'packages/core/src/ports/storage.ts',
      'export interface SettingsStore {\n  read(scope: string): Promise<ProviderSecret | null>;\n}\n',
    );
    const violation = verifyNoKeyStorage(root).find((candidate) => candidate.rule === 'K2');
    expect(violation?.detail).toContain('ProviderSecret');
  });

  it('allows an identifier across the same seam', () => {
    cleanTree();
    write(
      'packages/core/src/ports/storage.ts',
      'export interface SettingsStore {\n  setSessionKeyId(scope: string, sessionKeyId: string): Promise<void>;\n}\n',
    );
    expect(verifyNoKeyStorage(root)).toEqual([]);
  });

  it('does not flag the secrets port, whose whole job is carrying a credential', () => {
    cleanTree();
    write(
      'packages/core/src/ports/secrets.ts',
      'export interface SecretsPort {\n  get(ref: SecretRef): Promise<string | null>;\n}\n',
    );
    expect(verifyNoKeyStorage(root)).toEqual([]);
  });
});

// ── K3 ───────────────────────────────────────────────────────────────────────

describe('K3 — no credential reaches disk, a database, a response, a log or telemetry', () => {
  it('flags each sink kind', () => {
    const cases: Array<[string, string]> = [
      ['disk', 'writeFileSync(cachePath, apiKey);'],
      ['database', 'await db.query(INSERT, [apiKey]);'],
      ['response', 'writeJson(res, 200, { apiKey });'],
      ['log', 'console.log("provider failed", apiKey);'],
      ['telemetry', 'span.setAttributes({ apiKey });'],
      ['store write', 'await store.putProvider({ slug, apiKey });'],
      ['interpolation', 'logger.info(`using ${apiKey}`);'],
    ];
    for (const [label, line] of cases) {
      cleanTree();
      write('packages/core/src/leak.ts', `${line}\n`);
      expect(rules(), label).toContain('K3');
      rmSync(path.join(root, 'packages/core/src/leak.ts'), { force: true });
    }
  });

  it('names the call and the value so the failure is actionable', () => {
    cleanTree();
    write('packages/core/src/leak.ts', 'console.error("boom", provider.apiKey);\n');
    const violation = verifyNoKeyStorage(root).find((candidate) => candidate.rule === 'K3');
    expect(violation?.file).toBe('packages/core/src/leak.ts:1');
    expect(violation?.detail).toContain('console.error');
    expect(violation?.detail).toContain('apiKey');
  });

  it('does not flag prose, a commented-out call, or an identifier', () => {
    cleanTree();
    write(
      'packages/core/src/ok.ts',
      [
        'logger.info("no session key on this daemon; re-pair to continue");',
        'logger.info("link paired", { linkId, sessionKeyId });',
        '// console.log(apiKey);',
        'this.keyring.set(linkId, sessionKey);',
      ].join('\n'),
    );
    expect(verifyNoKeyStorage(root)).toEqual([]);
  });
});

// ── K4 ───────────────────────────────────────────────────────────────────────

describe('K4 — no shape the daemon persists holds a provider key', () => {
  function daemonTree(linkFields: string): void {
    cleanTree();
    write('packages/protocol/src/link.ts', `export interface Link {\n${linkFields}\n}\n`);
    write(
      'packages/daemon/src/store.ts',
      [
        'import type { Link } from "@forgebridge/protocol";',
        'export interface DaemonStore {',
        '  putLink(link: Link): Promise<void>;',
        '  getLink(linkId: string): Promise<Link | null>;',
        '}',
      ].join('\n'),
    );
  }

  it('passes when the link carries only a key identifier', () => {
    daemonTree('  id: string;\n  sessionKeyId: string | null;');
    expect(verifyNoKeyStorage(root)).toEqual([]);
  });

  it('flags a session key smuggled onto a shape the daemon store writes', () => {
    daemonTree('  id: string;\n  sessionKey: Buffer;');
    const violation = verifyNoKeyStorage(root).find((candidate) => candidate.rule === 'K4');
    expect(violation?.file).toBe('packages/protocol/src/link.ts:3');
    expect(violation?.detail).toContain('ADR-006');
  });

  it('flags a provider key added to the daemon store module itself', () => {
    daemonTree('  id: string;');
    write(
      'packages/daemon/src/store.ts',
      [
        'export interface ProviderRecord {',
        '  slug: string;',
        '  providerKey: string;',
        '}',
        'export interface DaemonStore {',
        '  putProvider(record: ProviderRecord): Promise<void>;',
        '}',
      ].join('\n'),
    );
    expect(rules()).toContain('K4');
  });
});

// ── The repository as it stands ──────────────────────────────────────────────

describe('the real tree', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

  it('passes every rule', () => {
    expect(verifyNoKeyStorage(repoRoot)).toEqual([]);
  });

  it('actually reached something — a gate that scanned nothing also passes', () => {
    const report = scanKeyCustody(repoRoot);
    expect(report.roots.find((entry) => entry.root === 'packages')?.tsFiles).toBeGreaterThan(20);
    expect(report.persisted.length).toBeGreaterThan(10);
    // The daemon's link record and the protocol's changeset are the two shapes
    // the promise is really about; if the closure stops reaching them the gate
    // has quietly narrowed.
    const names = report.persisted.map((shape) => shape.declaration.name);
    expect(names).toContain('Link');
    expect(names).toContain('ChangeSet');
    expect(report.sinkCount.log + report.sinkCount.telemetry).toBeGreaterThan(0);
  });

  it('reports what it waved through, by name', () => {
    // The summary is part of the gate: an exemption nobody can read is a hole.
    const allowed = scanKeyCustody(repoRoot).allowed.map((entry) => entry.name);
    expect(allowed).toContain('sessionKeyId');
    expect(allowed).toContain('promptTokens');
  });
});
