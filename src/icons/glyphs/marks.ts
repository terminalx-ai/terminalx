/**
 * Neutral stand-ins for the marks no open library carries (the owner asked
 * Simple Icons to drop them, or they were never there): each says what the
 * thing is with a plain motif in the set's own style, and copies no logo.
 */
import { BOX, dot, type Glyph } from "./shared";

/** A page with its corner folded, as every file-type icon is drawn on. */
const PAGE: Glyph[number] = ["path", { d: "M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5zM9 1.5v4h4" }];
const CLOUD = "M4.75 13.5a3.25 3.25 0 0 1-.5-6.46A4.5 4.5 0 0 1 12.9 7.5a3 3 0 0 1-.4 6z";

export const GLYPHS: Record<string, Glyph> = {
  // ---- products
  LogoAzure: [["path", { d: CLOUD }], ["path", { d: "M6.5 11.5 8 8l1.5 3.5M7 10.5h2" }]],
  LogoAzureDevops: [["path", { d: "M4.5 5.5a2.5 2.5 0 0 0 0 5c1.5 0 2.5-1 3.5-2.5s2-2.5 3.5-2.5a2.5 2.5 0 0 1 0 5c-1.5 0-2.5-1-3.5-2.5S6 5.5 4.5 5.5z" }]],
  LogoMicrosoftTeams: [["circle", { cx: 5.5, cy: 6, r: 2 }], ["path", { d: "M1.5 13.5a4 4 0 0 1 8 0M9.5 3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1h-1.5L10.5 8V6.5a1 1 0 0 1-1-1z" }]],
  LogoSlack: [["path", { d: "M6 2.5v4M10 2.5v4M6 9.5v4M10 9.5v4M2.5 6h4M9.5 6h4M2.5 10h4M9.5 10h4" }]],
  LogoVscode: [BOX, ["path", { d: "M6 5.5 3.5 8 6 10.5M10 5.5 12.5 8 10 10.5" }]],
  LogoVscodeInsiders: [["rect", { x: 2, y: 2, width: 12, height: 12, rx: 1.5, strokeDasharray: "2.2 1.8" }], ["path", { d: "M6 5.5 3.5 8 6 10.5M10 5.5 12.5 8 10 10.5" }]],
  Bugbot: [["rect", { x: 3.5, y: 5.5, width: 9, height: 7, rx: 2 }], ["path", { d: "M8 5.5V3M5.5 3l1 1M10.5 3l-1 1M2 8h1.5M12.5 8H14M6 8.5v1.5M10 8.5v1.5M6.5 11h3M4.5 12.5 3.5 14M11.5 12.5l1 1.5" }]],

  // ---- file types
  FileTypeAdobeIllustrator: [PAGE, ["path", { d: "M5 12.5l1.5-4.5L8 12.5M5.5 11h2M10 9v3.5" }], dot(10, 7.5, 0.6)],
  FileTypeAdobePhotoshop: [PAGE, ["path", { d: "M5 12.5V8h1.5a1.25 1.25 0 0 1 0 2.5H5M11 9.8a1 1 0 0 0-1-.7c-.6 0-1 .3-1 .7s.5.6 1 .7 1 .3 1 .8-.4.8-1 .8a1 1 0 0 1-1-.7" }]],
  FileTypeBicep: [PAGE, ["path", { d: "M6.5 7.5c-.8 0-1 .4-1 1v.8c0 .5-.3.7-.8.7.5 0 .8.2.8.7v.8c0 .6.2 1 1 1M9.5 7.5c.8 0 1 .4 1 1v.8c0 .5.3.7.8.7-.5 0-.8.2-.8.7v.8c0 .6-.2 1-1 1" }]],
  FileTypeCSharp: [PAGE, ["path", { d: "M7.5 8.3A1.5 1.5 0 0 0 5 9.5v1a1.5 1.5 0 0 0 2.5 1.2M9.5 8l-.5 4M11.5 8l-.5 4M8.5 9.3h3.5M8.3 10.8h3.5" }]],
  FileTypeCuda: [PAGE, ["rect", { x: 5.5, y: 7.5, width: 5, height: 5, rx: 0.8 }], ["rect", { x: 7, y: 9, width: 2, height: 2, rx: 0.3 }]],
  FileTypeGeckodriver: [PAGE, ["path", { d: "M10.5 9a2.25 2.25 0 1 0 0 2h-2" }]],
  FileTypeGrails: [PAGE, ["path", { d: "M5.5 12.5c0-3 1.5-4.5 4.5-4.5 0 3-1.5 4.5-4.5 4.5zM5.5 12.5 8 10" }]],
  FileTypeHaml: [PAGE, ["path", { d: "M10.5 7.5 5.5 12.5" }], ["circle", { cx: 6.25, cy: 8.25, r: 0.9 }], ["circle", { cx: 9.75, cy: 11.75, r: 0.9 }]],
  FileTypeJava: [["path", { d: "M4 6.5h7v3.5a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3zM11 7.5h1a1.5 1.5 0 0 1 0 3h-1M6 2.5c-.8.8-.8 1.7 0 2.5M8.5 2.5c-.8.8-.8 1.7 0 2.5" }]],
  FileTypeKarma: [PAGE, ["circle", { cx: 8, cy: 10, r: 2.5 }], ["path", { d: "M6.9 10l.8.8 1.5-1.6" }]],
  FileTypeLiquid: [PAGE, ["path", { d: "M8 6.5s2.5 2.8 2.5 4.5a2.5 2.5 0 0 1-5 0c0-1.7 2.5-4.5 2.5-4.5z" }]],
  FileTypeMustache: [PAGE, ["path", { d: "M5 10.5c1-1.5 2-1.5 3 0 1-1.5 2-1.5 3 0-.5 1-1.5 1.5-3 .5-1.5 1-2.5.5-3-.5z" }]],
  FileTypeOdata: [PAGE, ["path", { d: "M6 8.5c0 .6.9 1 2 1s2-.4 2-1-.9-1-2-1-2 .4-2 1zM6 8.5v3c0 .6.9 1 2 1s2-.4 2-1v-3" }]],
  FileTypePowershell: [PAGE, ["path", { d: "M5.5 8.5l2 1.5-2 1.5M8.5 11.5h2.5" }]],
  FileTypeProlog: [PAGE, ["path", { d: "M6.5 8.5a1.3 1.3 0 1 1 1.8 1.2c-.3.1-.5.4-.5.7M9.5 10.5h2" }], dot(7.8, 11.8, 0.5)],
  FileTypeSbt: [PAGE, ["path", { d: "M9 8.8a1.2 1.2 0 0 0-1.1-.8c-.7 0-1.2.4-1.2.9s.5.7 1.2.9 1.2.4 1.2.9-.5.9-1.2.9a1.2 1.2 0 0 1-1.1-.8" }]],
  FileTypeSlim: [PAGE, ["path", { d: "M5.5 8.5h5M5.5 10.5h3.5M5.5 12.5h2" }]],
  FileTypeVsc: [PAGE, ["path", { d: "M6.5 8.5 5 10l1.5 1.5M9.5 8.5 11 10l-1.5 1.5" }]],
  FileTypeWindows: [PAGE, ["rect", { x: 5.5, y: 7.5, width: 5, height: 5, rx: 0.6 }], ["path", { d: "M8 7.5v5M5.5 10h5" }]],
};
