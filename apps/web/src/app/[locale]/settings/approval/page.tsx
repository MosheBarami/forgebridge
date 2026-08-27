import type { Metadata } from 'next';

import { DEFAULT_LOCALE, isLocale } from '@/i18n/config';
import { getDictionary } from '@/i18n/dictionaries';
import { createTranslate } from '@/i18n/translate';
import { ApprovalPolicyForm } from '@/components/settings/approval-policy-form';

/**
 * Settings → Approval.
 *
 * The one page in this app where a user can make the product less safe, which
 * is why the form beneath makes that a scoped, deliberate, three-step act —
 * name a folder, confirm the folder, then turn it on — rather than a switch.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}): Promise<Metadata> {
  const { locale } = await params;
  const t = createTranslate(await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE));
  return { title: t('settings.section.approval') };
}

export default async function ApprovalSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const t = createTranslate(await getDictionary(isLocale(locale) ? locale : DEFAULT_LOCALE));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex max-w-[var(--fb-measure)] flex-col gap-2">
        <h1 className="text-[1.5rem]">{t('settings.approval.title')}</h1>
        <p className="text-fg-muted">{t('settings.approval.lede')}</p>
      </header>
      <ApprovalPolicyForm />
    </div>
  );
}
