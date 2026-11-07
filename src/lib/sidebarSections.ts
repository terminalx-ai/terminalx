/** Shared naming and placement for personal cloud-project and local-session sections. */
export function freeSectionName<T extends { name: string }>(sections: readonly T[], base = "New section"): string {
  const taken = new Set(sections.map((section) => section.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** Keep item order inside each section, with duplicate memberships resolved first-wins. */
export function groupSidebarItems<T, S extends { id: string }>(items: readonly T[], sections: readonly S[], key: (item: T) => string, members: (section: S) => readonly string[]): { sections: { section: S; items: T[] }[]; ungrouped: T[] } {
  const placed = new Map<string, string>();
  for (const section of sections) for (const id of members(section)) if (!placed.has(id)) placed.set(id, section.id);
  return {
    sections: sections.map((section) => ({ section, items: items.filter((item) => placed.get(key(item)) === section.id) })),
    ungrouped: items.filter((item) => !placed.has(key(item))),
  };
}
