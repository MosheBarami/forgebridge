import { THEME_STORAGE_KEY } from '@/lib/theme';

/**
 * Resolve the theme before first paint.
 *
 * Without this the server renders with no `data-theme`, the CSS media query
 * decides, and a user who chose light on a dark OS sees a dark flash and then a
 * jump. That flash is not cosmetic here: the first thing this app shows is a
 * status indicator whose colour carries meaning, and a colour that changes
 * under the reader is a colour they stop trusting.
 *
 * It is an inline blocking script because there is no other place to run code
 * between HTML parsing and first paint. It is the only inline script in the
 * app, it reads one key and writes one attribute, and it is built from a
 * constant rather than a loose string so the key cannot drift from `theme.ts`.
 */
export function ThemeScript() {
  const source = `(function(){try{
var p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
if(p!=="light"&&p!=="dark"&&p!=="system")p="system";
var r=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p;
document.documentElement.setAttribute("data-theme",r);
}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;

  return <script suppressHydrationWarning dangerouslySetInnerHTML={{ __html: source }} />;
}
