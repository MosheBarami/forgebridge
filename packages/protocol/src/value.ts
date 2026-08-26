import { z } from 'zod';
import { InstancePath } from './path.js';

/**
 * Roblox property values, as a closed discriminated union.
 *
 * A permissive `z.unknown()` here would defeat the whole protocol: the plugin
 * would have to guess how to coerce a value into a Roblox datatype, and a model
 * could pass a shape nobody validated straight into `Instance[property] = …`.
 * Every datatype ForgeBridge can set is listed, and anything else is refused at
 * the boundary with a message naming the datatype.
 */

const finite = z.number().finite();
const unit = z.number().min(0).max(1);

export const Vector3Value = z.object({
  t: z.literal('Vector3'), x: finite, y: finite, z: finite,
});
export const Vector2Value = z.object({
  t: z.literal('Vector2'), x: finite, y: finite,
});
export const Color3Value = z.object({
  t: z.literal('Color3'), r: unit, g: unit, b: unit,
});
export const UDimValue = z.object({
  t: z.literal('UDim'), scale: finite, offset: z.number().int(),
});
export const UDim2Value = z.object({
  t: z.literal('UDim2'),
  xScale: finite, xOffset: z.number().int(),
  yScale: finite, yOffset: z.number().int(),
});
export const RectValue = z.object({
  t: z.literal('Rect'), minX: finite, minY: finite, maxX: finite, maxY: finite,
});

/**
 * A CFrame as position + a 3x3 rotation matrix in row-major order.
 * Euler angles were rejected: they need a convention both sides agree on, and
 * a mismatch is a silently rotated model rather than an error.
 */
export const CFrameValue = z.object({
  t: z.literal('CFrame'),
  position: z.tuple([finite, finite, finite]),
  rotation: z.tuple([
    finite, finite, finite,
    finite, finite, finite,
    finite, finite, finite,
  ]),
});

export const BrickColorValue = z.object({
  t: z.literal('BrickColor'), name: z.string().min(1).max(64),
});

/** An enum member, addressed by name so the wire is readable and stable. */
export const EnumValue = z.object({
  t: z.literal('Enum'),
  enum: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
  value: z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/),
});

/**
 * A reference to another instance in the same place, by path.
 *
 * Validated as a full InstancePath, not a loose string. A reference IS a path,
 * and the segment restrictions in path.ts exist precisely so a name cannot
 * smuggle a separator past a policy prefix check. Leaving this as
 * `z.string().min(1)` would have left exactly one hole in that guard — and the
 * policy layer would never have seen it either, because `pathsOf` did not
 * report reference targets. Both halves are fixed; see `pathsOf`.
 */
export const InstanceRefValue = z.object({
  t: z.literal('InstanceRef'), path: InstancePath,
});

export const ColorSequenceValue = z.object({
  t: z.literal('ColorSequence'),
  keypoints: z.array(z.object({ time: unit, r: unit, g: unit, b: unit })).min(2).max(20),
});

export const NumberSequenceValue = z.object({
  t: z.literal('NumberSequence'),
  keypoints: z.array(z.object({ time: unit, value: finite, envelope: finite.default(0) })).min(2).max(20),
});

export const NumberRangeValue = z.object({
  t: z.literal('NumberRange'), min: finite, max: finite,
});

export const FontValue = z.object({
  t: z.literal('Font'),
  family: z.string().min(1).max(200),
  weight: z.string().regex(/^[A-Za-z]+$/).default('Regular'),
  style: z.enum(['Normal', 'Italic']).default('Normal'),
});

/** Primitive scalars, tagged for symmetry with the datatypes above. */
export const StringValue = z.object({ t: z.literal('String'), v: z.string().max(200_000) });
export const NumberValue = z.object({ t: z.literal('Number'), v: finite });
export const IntValue = z.object({ t: z.literal('Int'), v: z.number().int() });
export const BoolValue = z.object({ t: z.literal('Bool'), v: z.boolean() });
export const NilValue = z.object({ t: z.literal('Nil') });

export const PropertyValue = z.discriminatedUnion('t', [
  StringValue, NumberValue, IntValue, BoolValue, NilValue,
  Vector3Value, Vector2Value, Color3Value,
  UDimValue, UDim2Value, RectValue, CFrameValue,
  BrickColorValue, EnumValue, InstanceRefValue,
  ColorSequenceValue, NumberSequenceValue, NumberRangeValue, FontValue,
]);

export type PropertyValue = z.infer<typeof PropertyValue>;

/** Every datatype tag the protocol understands — used in error messages. */
export const PROPERTY_VALUE_TAGS = [
  'String', 'Number', 'Int', 'Bool', 'Nil',
  'Vector3', 'Vector2', 'Color3',
  'UDim', 'UDim2', 'Rect', 'CFrame',
  'BrickColor', 'Enum', 'InstanceRef',
  'ColorSequence', 'NumberSequence', 'NumberRange', 'Font',
] as const;

/**
 * Property names are validated too. Roblox property names are identifiers, and
 * accepting arbitrary strings would let a ChangeSet reach for prototype keys
 * (`__index`, `constructor`) when the plugin indexes a property bag.
 */
export const PropertyName = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/, 'property name must be an identifier')
  .max(100)
  .refine((n) => !['__index', '__newindex', '__metatable', 'constructor', 'prototype'].includes(n), {
    message: 'reserved property name',
  });
