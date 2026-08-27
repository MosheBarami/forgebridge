/**
 * Dictionary lookup.
 *
 * The contract with the three agents building surfaces on this shell: a key
 * that is not in the dictionary yet renders **as the key**, in place, and
 * nothing throws. That is deliberate. A surface under construction should be
 * visibly under construction — a missing string showing as
 * `generate.approve.confirm` is a to-do a reviewer can see and a translator can
 * find, whereas an empty string is a layout that looks finished and is not.
 *
 * `t` never returns `undefined`, so no caller needs a fallback of its own.
 */

export type Dictionary = Readonly<Record<string, unknown>>;

export type Translate = (key: string, vars?: Readonly<Record<string, string | number>>) => string;

function lookup(dictionary: Dictionary, key: string): string | undefined {
  let node: unknown = dictionary;
  for (const segment of key.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return typeof node === 'string' ? node : undefined;
}

/**
 * `{name}` placeholders only. No plural rules, no gender, no ICU.
 *
 * Hebrew needs all three eventually, and pretending a `{count}` substitution
 * handles its dual form would be worse than not offering the feature: a wrong
 * plural reads as broken software to a native speaker, while an untranslated
 * key reads as unfinished software, which it is. TODO(M39): a real message
 * formatter, chosen once the surfaces know which of them actually need one.
 */
export function createTranslate(dictionary: Dictionary): Translate {
  return (key, vars) => {
    const found = lookup(dictionary, key);
    if (found === undefined) return key;
    if (!vars) return found;
    return found.replace(/\{(\w+)\}/g, (whole, name: string) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
    );
  };
}
