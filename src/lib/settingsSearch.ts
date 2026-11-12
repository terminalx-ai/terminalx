import { indexPaletteItem, rankPaletteItems, type MatchRange } from "@/lib/commandPalette";
import { settingsSectionOffered } from "@/lib/settingsSections";
import { SETTINGS_ROWS, SETTINGS_SECTIONS, type SettingId, type SettingRegistration, type SettingsSection } from "@/components/settings/settingsRegistry";

/**
 * Search Settings by row (PRO-127): every registry row is indexed by its
 * title, then its description, then its search terms, with the command
 * palette's matcher, so a title match ranks ahead of a description match and
 * a description match ahead of a search term. The Settings page, ⌘K and the
 * deep-link handler all read this one index.
 */

/** At most this many rows are returned for one query. */
export const SETTINGS_SEARCH_LIMIT = 30;

export interface SettingSearchMatch {
  id: SettingId;
  row: SettingRegistration;
  section: SettingsSection;
  /** The section's title, the page the row is on. */
  sectionTitle: string;
  /** Lower is better. */
  score: number;
  /** Ranges of `row.title` that matched, for highlighting. */
  titleRanges: MatchRange[];
  /** Ranges of `row.description` that matched, for highlighting. */
  descriptionRanges: MatchRange[];
}

export interface SettingSearchPage {
  section: SettingsSection;
  title: string;
  matches: SettingSearchMatch[];
}

const rowIndex = SETTINGS_ROWS.map((row) => indexPaletteItem({
  id: row.id,
  group: "settings-row",
  row: row as SettingRegistration,
  primary: row.title,
  secondary: row.description,
  recentAt: 0,
}, [...row.searchTerms]));

/**
 * Rows matching `query`, best first, at most SETTINGS_SEARCH_LIMIT. A blank
 * query matches nothing: the page lists its sections instead. Rows of a
 * section behind an Experimental switch (Orchestrator) are found only while
 * that switch is on, by the same rule as the section search.
 */
export function searchSettings(query: string): SettingSearchMatch[] {
  if (!query.trim()) return [];
  const matches: SettingSearchMatch[] = [];
  for (const match of rankPaletteItems(rowIndex, query)) {
    const row = match.item.row;
    if (!settingsSectionOffered(row.section)) continue;
    matches.push({
      id: row.id as SettingId,
      row,
      section: row.section,
      sectionTitle: SETTINGS_SECTIONS[row.section].title,
      score: match.score,
      titleRanges: match.primaryRanges,
      descriptionRanges: match.secondaryRanges,
    });
    if (matches.length === SETTINGS_SEARCH_LIMIT) break;
  }
  return matches;
}

/** Matches grouped by the page (section) they are on, pages in order of their best match. */
export function groupSettingsByPage(matches: readonly SettingSearchMatch[]): SettingSearchPage[] {
  const pages = new Map<SettingsSection, SettingSearchPage>();
  for (const match of matches) {
    let page = pages.get(match.section);
    if (!page) pages.set(match.section, page = { section: match.section, title: match.sectionTitle, matches: [] });
    page.matches.push(match);
  }
  return [...pages.values()];
}

/** "3 settings on 2 pages", "1 setting on 1 page". */
export function settingsSearchSummary(matches: readonly SettingSearchMatch[]): string {
  const settings = matches.length;
  const pages = new Set(matches.map((match) => match.section)).size;
  return `${settings} ${settings === 1 ? "setting" : "settings"} on ${pages} ${pages === 1 ? "page" : "pages"}`;
}
