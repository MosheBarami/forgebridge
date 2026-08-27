import { carriesLuauSource, isDestructive, pathsOf, type ChangeSet, type Operation } from '@forgebridge/protocol';
import type { OperationDiff } from './wire.js';

/**
 * Rendering a ChangeSet for a human to approve.
 *
 * ── An honest note about this copy ───────────────────────────────────────────
 *
 * `describeOperation` and `afterValueOf` in `packages/daemon/src/server.ts` are
 * module-private: not exported, not reachable, and not comparable from a test
 * the way `envelope.ts` and `wire.ts` are. So unlike the other copies in this
 * app, this one has NO automatic drift gate, and saying so is the point — a
 * comment claiming a gate that does not exist is the failure mode this
 * repository has a documentation gate for.
 *
 * What makes that acceptable is the split below. The parts a safety decision
 * rests on do not live here at all:
 *
 *  - `counts.scripts` is `carriesLuauSource` from the protocol, not a local
 *    idea of what a script is. The daemon's diff reported `scripts: 0` over a
 *    set that installed a Script through `createInstance`, and the fix was to
 *    move the predicate into the protocol so there is one definition. This file
 *    calls that definition.
 *  - `paths` is `pathsOf`, so a reference buried in a property bag appears on
 *    the page for the same reason the policy layer sees it.
 *  - `destructive` is `isDestructive`.
 *  - `after` renders Luau verbatim whichever operation installed it, because a
 *    reviewer must not have to know which of three operations carried the code
 *    in order to read it.
 *
 * What is genuinely local is the English: "create Part at …", "3 properties".
 * A drift there is a sentence that reads differently on two transports, which
 * is a cosmetic defect. A drift in the four points above would be a diff that
 * hides code, and none of those four can drift, because none of them is here.
 */

/** The string a `PropertyValue` holds, or null when it does not hold one. */
export function sourceTextOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const property = value as { t?: unknown; v?: unknown };
  return property.t === 'String' && typeof property.v === 'string' ? property.v : null;
}

export function countOps(operations: readonly Operation[], kind: Operation['op']): number {
  return operations.filter((operation) => operation.op === kind).length;
}

export function describeOperation(operation: Operation): string {
  switch (operation.op) {
    case 'createInstance': {
      // Not a bare "create Script at <path>". A `createInstance` carrying a
      // `Source` property installs Luau exactly as `writeScript` does, and a
      // one-line summary that does not say so is the line a reviewer skims
      // before approving code they never saw.
      const source = sourceTextOf(operation.properties.Source);
      const others = Object.keys(operation.properties).length - (source !== null ? 1 : 0);
      const parts: string[] = [];
      if (source !== null) parts.push(`${Buffer.byteLength(source, 'utf8')} bytes of Source`);
      if (others > 0) parts.push(`${others} propert${others === 1 ? 'y' : 'ies'}`);
      const head = `create ${operation.className} at ${operation.path}`;
      return parts.length > 0 ? `${head} with ${parts.join(' and ')}` : head;
    }
    case 'setProperty':
      return `set ${operation.path}.${operation.property}`;
    case 'writeScript':
      return `write ${operation.scriptType} ${operation.path} (${Buffer.byteLength(operation.source, 'utf8')} bytes)`;
    case 'moveInstance':
      return `move ${operation.path} to ${operation.to}`;
    case 'deleteInstance':
      return `delete ${operation.path}`;
  }
}

/** The value an operation writes, rendered for a human. */
export function afterValueOf(operation: Operation): { after?: string; properties?: Record<string, string> } {
  switch (operation.op) {
    case 'writeScript':
      return { after: operation.source };
    case 'setProperty':
      return { after: JSON.stringify(operation.value) };
    case 'createInstance': {
      const properties: Record<string, string> = {};
      let after: string | undefined;
      for (const [name, value] of Object.entries(operation.properties)) {
        const source = name === 'Source' ? sourceTextOf(value) : null;
        if (source !== null) after = source;
        else properties[name] = JSON.stringify(value);
      }
      return {
        ...(after !== undefined ? { after } : {}),
        ...(Object.keys(properties).length > 0 ? { properties } : {}),
      };
    }
    case 'moveInstance':
    case 'deleteInstance':
      // Both are fully described by their paths, which the diff already carries.
      return {};
  }
}

export function operationDiffs(changeSet: ChangeSet): OperationDiff[] {
  return changeSet.operations.map((operation, index) => ({
    index,
    op: operation.op,
    paths: pathsOf(operation),
    summary: describeOperation(operation),
    destructive: isDestructive(operation),
    ...afterValueOf(operation),
  }));
}

export function diffCounts(changeSet: ChangeSet): {
  total: number;
  creates: number;
  setProperties: number;
  scripts: number;
  moves: number;
  deletes: number;
} {
  return {
    total: changeSet.operations.length,
    creates: countOps(changeSet.operations, 'createInstance'),
    setProperties: countOps(changeSet.operations, 'setProperty'),
    // The protocol's predicate, so this number and the analyser gate cannot
    // disagree about what counts as code.
    scripts: changeSet.operations.filter(carriesLuauSource).length,
    moves: countOps(changeSet.operations, 'moveInstance'),
    deletes: countOps(changeSet.operations, 'deleteInstance'),
  };
}
