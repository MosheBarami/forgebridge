import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { CARDS, cardById, cardKey } from '../catalog';
import { CardDetail } from '../card-detail';

/**
 * One card, at its own address.
 *
 * A route rather than a panel on the list, for two reasons that matter more
 * than the extra file: a card is the unit people will link each other to, and a
 * reader who has just filtered the list to three cards and opened one must be
 * able to press Back and still have those three — which they do, because the
 * list keeps its filter in the query string.
 *
 * Every card is prerendered. The catalog is a compile-time constant, so there
 * is nothing to fetch and nothing that can fail at request time.
 */
export function generateStaticParams(): Array<{ cardId: string }> {
  return CARDS.map((card) => ({ cardId: card.id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string; cardId: string }>;
}): Promise<Metadata> {
  const { locale, cardId } = await params;
  const card = cardById(cardId);
  if (!card) return {};
  const dictionary = await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE);
  const t = createTranslate(dictionary);
  return {
    title: t(cardKey(card.id, 'title')),
    description: t(cardKey(card.id, 'summary')),
  };
}

export default async function CardPage({
  params,
}: {
  params: Promise<{ locale: string; cardId: string }>;
}) {
  const { cardId } = await params;
  const card = cardById(cardId);
  // An unknown card id is a 404, not an empty detail page. The set of cards is
  // known at build time, so there is no "maybe it will exist later" case.
  if (!card) notFound();

  return <CardDetail card={card} />;
}
