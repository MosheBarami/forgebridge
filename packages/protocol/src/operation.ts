import { z } from 'zod';
import { InstancePath } from './path.js';
import { PropertyValue, PropertyName } from './value.js';
import { LIMITS } from './limits.js';

/**
 * Roblox class names a ChangeSet may instantiate is NOT restricted here —
 * the protocol accepts any identifier and the *policy* layer in
 * `@forgebridge/core` decides what is allowed for a given project. Keeping the
 * allowlist out of the wire format means tightening it does not require a
 * plugin release.
 */
export const ClassName = z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/).max(100);

/**
 * A bag of properties keyed by property name. Keys are checked with an explicit
 * superRefine rather than `z.record(PropertyName, …)`: PropertyName carries a
 * `.refine()` and so is a ZodEffects, which z.record will not accept as a key
 * schema. Doing it by hand also produces a message naming the offending key.
 */
export const PropertyBag = z
  .record(z.string(), PropertyValue)
  .superRefine((bag, ctx) => {
    for (const key of Object.keys(bag)) {
      const parsed = PropertyName.safeParse(key);
      if (!parsed.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `invalid property name "${key}": ${parsed.error.issues[0]?.message ?? 'rejected'}`,
          path: [key],
        });
      }
    }
  });

export const ScriptType = z.enum(['Script', 'LocalScript', 'ModuleScript']);
export type ScriptType = z.infer<typeof ScriptType>;

const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

const ScriptSource = z.string().refine(
  (s) => utf8Bytes(s) <= LIMITS.MAX_SCRIPT_BYTES,
  { message: `script source exceeds ${LIMITS.MAX_SCRIPT_BYTES} bytes` },
);

export const CreateInstanceOp = z.object({
  op: z.literal('createInstance'),
  path: InstancePath,
  className: ClassName,
  properties: PropertyBag.default({}),
});

/**
 * Properties that relocate or rename an instance rather than change its state.
 *
 * `Parent` is the one that matters: assigning it moves an entire subtree, and
 * assigning it `nil` detaches one. As an ordinary `setProperty` that is a
 * structural change wearing a property's clothes, and it slips every gate at
 * once — the policy allowlist only inspects the paths an operation *reports*,
 * the bulk-delete counter only counts `deleteInstance`, and scoped auto-apply
 * only excludes `deleteInstance`. So a set of `Parent` could move work out of
 * an allowed prefix, or detach it entirely, without approval.
 *
 * `Name` is refused for the same structural reason: it invalidates the path
 * every other operation and every journalled inverse is keyed on.
 *
 * `moveInstance` exists for exactly this, reports both endpoints through
 * `pathsOf`, and journals a resolvable `moveBack` inverse. Use it.
 */
export const STRUCTURAL_PROPERTIES = ['Parent', 'Name'] as const;

export const SetPropertyOp = z.object({
  op: z.literal('setProperty'),
  path: InstancePath,
  property: PropertyName.refine(
    (name) => !(STRUCTURAL_PROPERTIES as readonly string[]).includes(name),
    { message: 'use moveInstance to reparent or rename; setProperty may not write Parent or Name' },
  ),
  value: PropertyValue,
});

export const WriteScriptOp = z.object({
  op: z.literal('writeScript'),
  path: InstancePath,
  scriptType: ScriptType,
  source: ScriptSource,
});

export const MoveInstanceOp = z.object({
  op: z.literal('moveInstance'),
  path: InstancePath,
  to: InstancePath,
});

export const DeleteInstanceOp = z.object({
  op: z.literal('deleteInstance'),
  path: InstancePath,
});

export const Operation = z.discriminatedUnion('op', [
  CreateInstanceOp, SetPropertyOp, WriteScriptOp, MoveInstanceOp, DeleteInstanceOp,
]);

export type Operation = z.infer<typeof Operation>;
export type OperationKind = Operation['op'];

/**
 * Every path an operation touches — including paths that appear only inside
 * property *values*.
 *
 * An `InstanceRef` in a property bag names another instance, and the policy
 * allowlist has to see it: a ChangeSet confined to an allowed prefix can still
 * wire a reference at something outside it. Returning only `operation.path`
 * meant `checkPolicy` iterated a list that was missing exactly the paths a
 * model could choose freely.
 */
export function pathsOf(operation: Operation): string[] {
  const paths: string[] = [operation.path];

  if (operation.op === 'moveInstance') {
    paths.push(operation.to);
  } else if (operation.op === 'setProperty') {
    if (operation.value.t === 'InstanceRef') paths.push(operation.value.path);
  } else if (operation.op === 'createInstance') {
    for (const value of Object.values(operation.properties)) {
      if (value.t === 'InstanceRef') paths.push(value.path);
    }
  }

  return paths;
}

/** Operations that can destroy work the user did not ask to lose. */
export function isDestructive(operation: Operation): boolean {
  return operation.op === 'deleteInstance' || operation.op === 'moveInstance';
}
