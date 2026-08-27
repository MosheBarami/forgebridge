import { afterEach, describe, expect, it } from 'vitest';
import {
  json,
  makeChangeSet,
  pairSession,
  passingValidation,
  producerHeaders,
  startRelay,
} from './helpers.js';

/**
 * The relay computes no validation, and refuses to carry a ChangeSet that has
 * none.
 *
 * This is the honesty requirement with the sharpest edge in the whole app.
 * PROTOCOL invariant 4 says validation is produced by the core and never by the
 * model, and the daemon enforces it by overwriting whatever verdict arrived
 * with one it computed inside its own trust boundary. The relay cannot do that:
 * `@forgebridge/core` and the Luau analyser are exactly the brain this
 * transport does not carry, and importing them would make the relay a thing
 * that reads and reasons about user code.
 *
 * That leaves two options and only one of them is defensible:
 *
 *   (a) accept a set with no verdict and let it be approved — which makes the
 *       relay a way to route around validation entirely. Pick the transport,
 *       skip the analyser. That is a bypass, not a limitation, and it is
 *       precisely the shape every bypass found in this repository has had: a
 *       check that could not resolve something and passed anyway.
 *   (b) refuse. A ChangeSet arrives here already validated by whoever ran the
 *       core, or it does not arrive.
 *
 * (b), with provenance rather than endorsement: `Validation.computedBy` is
 * carried through untouched and `validationWitnessedHere: false` rides on the
 * diff, so a reviewer is told the verdict on their page is one the relay is
 * relaying. Note what that is NOT — it is not a claim the verdict is genuine.
 * The relay cannot check that and says so. The transport where the verdict is
 * computed by the same process that serves it is the local daemon.
 */

const open: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

describe('a ChangeSet with no verdict does not get carried', () => {
  it('refuses it at submit, and names the two ways forward', async () => {
    const started = await startRelay();
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);

    const refused = await fetch(`${started.base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify(makeChangeSet({ projectId: session.projectId, validation: undefined })),
    });
    expect(refused.status).toBe(400);
    const body = await json(refused);
    expect(String(body.message)).toContain('computes no validation');
    expect(String(body.remedy)).toContain('@forgebridge/core');
    expect(String(body.remedy)).toContain('daemon');
  });

  it('accepts one that carries a verdict — CONTROL', async () => {
    // The legitimate shape this refusal is most confusable with: the web app's
    // backend runs the core, computes the verdict, and submits. A rule that
    // fired on that would train people to ignore it.
    const started = await startRelay();
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);
    const accepted = await fetch(`${started.base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify(makeChangeSet({ projectId: session.projectId })),
    });
    expect(accepted.status).toBe(201);
  });
});

describe('the relay relays a verdict, it does not make one', () => {
  it('carries computedBy through untouched', async () => {
    const started = await startRelay();
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);
    const set = makeChangeSet({
      projectId: session.projectId,
      validation: passingValidation('forgebridge-core@9.9.9'),
    });

    const submitted = await json(
      await fetch(`${started.base}/v1/changesets`, {
        method: 'POST',
        headers: producerHeaders(session),
        body: JSON.stringify(set),
      }),
    );
    // Not rewritten to name the relay. A verdict that claimed this process
    // computed it would be the relay taking credit for work it cannot do.
    expect((submitted.validation as { computedBy: string }).computedBy).toBe('forgebridge-core@9.9.9');
    expect(submitted.validationWitnessedHere).toBe(false);
  });

  it('tells a reviewer on the diff page that it did not witness the verdict', async () => {
    const started = await startRelay();
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);
    const set = makeChangeSet({ projectId: session.projectId });
    await fetch(`${started.base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify(set),
    });

    const diff = await json(
      await fetch(`${started.base}/v1/changesets/${set.id as string}/diff`, { headers: producerHeaders(session) }),
    );
    // Without this the same page would mean two different things depending on
    // which base URL rendered it.
    expect(diff.validationWitnessedHere).toBe(false);
    expect(diff.treeAware).toBe(false);
    expect((diff.validation as { computedBy: string }).computedBy).toBe('test-core@0.0.0');
  });

  it('discards a producer-supplied status rather than believing it', async () => {
    const started = await startRelay();
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);
    // A set arriving pre-marked `approved` is a model clearing its own work
    // (ADR-012). The status is replaced, not merged.
    const set = { ...makeChangeSet({ projectId: session.projectId }), status: 'approved' };
    const submitted = await json(
      await fetch(`${started.base}/v1/changesets`, {
        method: 'POST',
        headers: producerHeaders(session),
        body: JSON.stringify(set),
      }),
    );
    expect(submitted.status).toBe('validated');

    const diff = await json(
      await fetch(`${started.base}/v1/changesets/${set.id as string}/diff`, { headers: producerHeaders(session) }),
    );
    expect(diff.status).toBe('validated');
  });
});

describe('a diff shows the code, however it arrived', () => {
  it('renders Source from a createInstance property bag as source, not as a property', async () => {
    // The bug found three times in this repository: a Script created with
    // `Source` in a `createInstance` bag showed as one line naming a class and
    // a path, with no code on the page. ADR-012 makes approval the safety
    // mechanism, and a diff that omits the Luau being installed turns that
    // mechanism into a formality.
    const started = await startRelay();
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);
    const set = makeChangeSet({
      projectId: session.projectId,
      operations: [
        {
          op: 'createInstance',
          path: 'ServerScriptService.Sneaky',
          className: 'Script',
          properties: { Source: { t: 'String', v: 'print("pwned")' }, Disabled: { t: 'Bool', v: false } },
        },
      ] as never,
    });
    await fetch(`${started.base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify(set),
    });

    const diff = await json(
      await fetch(`${started.base}/v1/changesets/${set.id as string}/diff`, { headers: producerHeaders(session) }),
    );
    expect((diff.counts as { scripts: number }).scripts).toBe(1);
    const operation = (diff.operations as Array<{ after?: string; properties?: Record<string, string>; summary: string }>)[0];
    expect(operation?.after).toBe('print("pwned")');
    expect(operation?.summary).toContain('bytes of Source');
    // The rest of the bag is still visible rather than dropped.
    expect(operation?.properties).toHaveProperty('Disabled');
  });

  it('counts a setProperty of Source as a script too', async () => {
    const started = await startRelay();
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);
    const set = makeChangeSet({
      projectId: session.projectId,
      operations: [
        {
          op: 'setProperty',
          path: 'ServerScriptService.Existing',
          property: 'Source',
          value: { t: 'String', v: 'print("also code")' },
        },
      ] as never,
    });
    await fetch(`${started.base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify(set),
    });
    const diff = await json(
      await fetch(`${started.base}/v1/changesets/${set.id as string}/diff`, { headers: producerHeaders(session) }),
    );
    expect((diff.counts as { scripts: number }).scripts).toBe(1);
  });

  it('does not count an ordinary property write as a script — CONTROL', async () => {
    const started = await startRelay();
    open.push(started.close);
    const session = await pairSession(started.relay, started.base);
    const set = makeChangeSet({
      projectId: session.projectId,
      operations: [
        { op: 'setProperty', path: 'Workspace.Part', property: 'Transparency', value: { t: 'Number', v: 0.5 } },
      ] as never,
    });
    await fetch(`${started.base}/v1/changesets`, {
      method: 'POST',
      headers: producerHeaders(session),
      body: JSON.stringify(set),
    });
    const diff = await json(
      await fetch(`${started.base}/v1/changesets/${set.id as string}/diff`, { headers: producerHeaders(session) }),
    );
    expect((diff.counts as { scripts: number }).scripts).toBe(0);
  });
});
