// Where to get Windows 11 23H2 ARM64: the list in windows-sources.json,
// typed. The imager never ships, mirrors or downloads Windows; these are
// links the user follows, and the app opens no other URLs of these sites.
import data from './windows-sources.json';
import type { Lang } from './i18n';

export interface WindowsSource {
  id: string;
  /** false: the page offers no image that runs on RK3576; shown so it is not mistaken for one. */
  fits: boolean;
  /** A short label such as "recommended", or null. */
  recommended: Record<Lang, string> | null;
  url: string;
  /** When the page was last checked (YYYY-MM-DD). */
  fetched: string;
  title: Record<Lang, string>;
  text: Record<Lang, string>;
}

export const WINDOWS_SOURCES: WindowsSource[] = data.sources;

/** Whether a link is one of the listed sources (the main process opens these in the browser). */
export function isWindowsSourceUrl(url: string): boolean {
  return WINDOWS_SOURCES.some((s) => s.url === url);
}

