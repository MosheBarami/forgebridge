import { NextResponse, type NextRequest } from 'next/server';

import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, negotiateLocale } from './i18n/config';

/**
 * Every path carries its locale.
 *
 * `/generate` is ambiguous — English or Hebrew? — and resolving it from a
 * cookie would give two users the same URL and different pages, which breaks
 * sharing a link and breaks caching in the same move. So the locale is in the
 * path, always, and this redirect is what puts it there.
 *
 * Precedence: an explicit choice (the cookie the locale switch writes) beats
 * the browser's `Accept-Language`, which beats the default. Someone who
 * overrode their browser's header meant it.
 */
export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const first = pathname.split('/')[1];
  if (isLocale(first)) return NextResponse.next();

  const fromCookie = request.cookies.get(LOCALE_COOKIE)?.value;
  const locale = isLocale(fromCookie)
    ? fromCookie
    : negotiateLocale(request.headers.get('accept-language')) || DEFAULT_LOCALE;

  const url = request.nextUrl.clone();
  // `/` becomes `/en`, not `/en/`; anything else keeps its path so a shared
  // link to a surface still lands on that surface.
  url.pathname = pathname === '/' ? `/${locale}` : `/${locale}${pathname}`;

  // 307, not 308: the negotiated target depends on a cookie and a header, so it
  // is not a permanent property of the source URL and must not be cached as one.
  return NextResponse.redirect(url, 307);
}

export const config = {
  /**
   * Everything except Next's own internals, well-known paths and anything with
   * a file extension. The extension test is what keeps `/robots.txt` and
   * `/icon.png` from being redirected into a locale that has no such file.
   */
  matcher: ['/((?!_next/|api/|\\.well-known/|favicon\\.ico|.*\\.[^/]+$).*)'],
};
