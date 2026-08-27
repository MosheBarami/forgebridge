import type { Dictionary } from './translate';
import type { Locale } from './config';

/**
 * The dictionary loader. Server-side only — it is imported from
 * `app/[locale]/layout.tsx`, which is a Server Component, and the resolved
 * dictionary is what crosses into the client (see `dictionary-context.tsx`).
 * Deliberately not marked with the `server-only` package: one more dependency
 * to enforce a rule that one import site already satisfies.
 *
 * A static map of dynamic imports rather than `import(`./dictionaries/${locale}.json`)`:
 * a template literal specifier makes the bundler include every JSON file it can
 * reach and defeats the point, and it would also let a bad `locale` value reach
 * the filesystem. Adding a locale here is one line in three places
 * (`config.ts`, this map, a JSON file) and `Record<Locale, …>` fails the build
 * if you forget this one.
 */
const LOADERS: Record<Locale, () => Promise<{ default: Dictionary }>> = {
  en: () => import('./dictionaries/en.json'),
  he: () => import('./dictionaries/he.json'),
};

export async function getDictionary(locale: Locale): Promise<Dictionary> {
  const loaded = await LOADERS[locale]();
  return loaded.default;
}
