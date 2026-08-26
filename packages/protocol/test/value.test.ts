import { describe, it, expect } from 'vitest';
import { PropertyValue, PropertyName } from '../src/value.js';

describe('PropertyValue', () => {
  it('accepts the tagged datatypes', () => {
    expect(PropertyValue.safeParse({ t: 'Vector3', x: 1, y: 2, z: 3 }).success).toBe(true);
    expect(PropertyValue.safeParse({ t: 'Color3', r: 0.5, g: 0, b: 1 }).success).toBe(true);
    expect(PropertyValue.safeParse({ t: 'Enum', enum: 'Material', value: 'Neon' }).success).toBe(true);
    expect(PropertyValue.safeParse({ t: 'Bool', v: true }).success).toBe(true);
  });

  it('refuses an untagged value', () => {
    expect(PropertyValue.safeParse('just a string').success).toBe(false);
    expect(PropertyValue.safeParse({ x: 1, y: 2, z: 3 }).success).toBe(false);
  });

  it('refuses an unknown datatype tag', () => {
    expect(PropertyValue.safeParse({ t: 'Ray', origin: [0, 0, 0] }).success).toBe(false);
  });

  it('refuses out-of-range colour components', () => {
    expect(PropertyValue.safeParse({ t: 'Color3', r: 255, g: 0, b: 0 }).success).toBe(false);
  });

  it('refuses non-finite numbers', () => {
    expect(PropertyValue.safeParse({ t: 'Number', v: Number.POSITIVE_INFINITY }).success).toBe(false);
    expect(PropertyValue.safeParse({ t: 'Number', v: Number.NaN }).success).toBe(false);
  });
});

describe('PropertyName', () => {
  it('accepts identifiers', () => {
    expect(PropertyName.safeParse('Transparency').success).toBe(true);
  });

  it('refuses prototype-pollution keys', () => {
    for (const bad of ['__index', '__newindex', 'constructor', 'prototype', '__metatable']) {
      expect(PropertyName.safeParse(bad).success).toBe(false);
    }
  });

  it('refuses non-identifier names', () => {
    expect(PropertyName.safeParse('some property').success).toBe(false);
    expect(PropertyName.safeParse('2Fast').success).toBe(false);
  });
});
