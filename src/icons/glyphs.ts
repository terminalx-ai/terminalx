/** Every glyph, by name. The category files each hold one family; a name in a later file wins. */
import type { Glyph } from "./glyphs/shared";
import { GLYPHS as CORE } from "./glyphs/core";
import { GLYPHS as ARROWS } from "./glyphs/arrows";
import { GLYPHS as GIT } from "./glyphs/git";
import { GLYPHS as FILES } from "./glyphs/files";
import { GLYPHS as PEOPLE } from "./glyphs/people";
import { GLYPHS as STATUS } from "./glyphs/status";
import { GLYPHS as OBJECTS } from "./glyphs/objects";
import { GLYPHS as BRANDS } from "./glyphs/brands";
import { GLYPHS as MARKS } from "./glyphs/marks";
import { ALIASES } from "./glyphs/aliases";

export type { Glyph } from "./glyphs/shared";

const DRAWN: Record<string, Glyph> = { ...CORE, ...ARROWS, ...GIT, ...FILES, ...PEOPLE, ...STATUS, ...OBJECTS, ...BRANDS, ...MARKS };
export const GLYPHS: Record<string, Glyph> = { ...DRAWN, ...Object.fromEntries(Object.entries(ALIASES).map(([alias, target]) => [alias, DRAWN[target]!])) };
