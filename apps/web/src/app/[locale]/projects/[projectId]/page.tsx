import { ProjectDetail } from './project-detail';

/**
 * One project (M34).
 *
 * `dynamicParams` is not set here and `generateStaticParams` is not exported,
 * which together mean this segment is rendered on demand. That is the only
 * honest option: the project ids that exist are the ones in a *visitor's*
 * IndexedDB, and a build has no way to enumerate them. There is nothing
 * secret being rendered — the whole page is a Client Component reading local
 * storage — so on-demand rendering of an empty shell costs nothing and avoids
 * pretending the server knows which projects exist.
 */
/**
 * Stated explicitly because the `[locale]` layout above sets `dynamicParams =
 * false` — an unknown locale is a 404 rather than a silent fallback. That is
 * right for locales, of which there are two and both are known at build time,
 * and wrong for project ids, of which there are as many as the visitor has
 * made. Without this line the closest ancestor's answer would apply and every
 * project would 404.
 */
export const dynamicParams = true;

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ locale: string; projectId: string }>;
}) {
  const { projectId } = await params;
  return <ProjectDetail projectId={projectId} />;
}
