/**
 * Files, folders, layout, windows, lists, grids and devices: the furniture of an editor.
 */
import { BOX, FOLDER, dot, type Glyph } from "./shared";

/** A page with its corner folded. */
const PAGE = "M9 1.5H4.5A1.5 1.5 0 0 0 3 3v10a1.5 1.5 0 0 0 1.5 1.5h7A1.5 1.5 0 0 0 13 13V5.5zM9 1.5v4h4";
/** A folder with its right side open, for something to sit in front of. */
const FOLDER_PART = "M7 13.5H3.5A1.5 1.5 0 0 1 2 12V4.5A1.5 1.5 0 0 1 3.5 3h2.6l1.5 1.5h4.9A1.5 1.5 0 0 1 14 6v1.5";
/** A window: the frame every layout icon starts from. */
const FRAME: Glyph[number] = ["rect", { x: 2, y: 3, width: 12, height: 10, rx: 1.5 }];
/** A monitor on its stand. */
const MONITOR = "M1.5 4a1.5 1.5 0 0 1 1.5-1.5h10A1.5 1.5 0 0 1 14.5 4v6a1.5 1.5 0 0 1-1.5 1.5H3A1.5 1.5 0 0 1 1.5 10zM5.5 14h5M8 11.5V14";
/** The small chat bubble a grid of them repeats. */
const bubble = (x: number, y: number) => `M${x + 0.5} ${y + 1}a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-1.5L${x + 1.5} ${y + 5.5}V${y + 4}a1 1 0 0 1-1-1z`;

export const GLYPHS: Record<string, Glyph> = {
  // ---- files
  File: [["path", { d: PAGE }]],
  FileAdd: [["path", { d: PAGE }], ["path", { d: "M8 7.5v4M6 9.5h4" }]],
  FileArrowRightUp: [["path", { d: PAGE }], ["path", { d: "M6.5 11l3-3M7 8h2.5v2.5" }]],
  FileChevronsLeftRight: [["path", { d: PAGE }], ["path", { d: "M6.5 8 5 9.5 6.5 11M9.5 8 11 9.5 9.5 11" }]],
  FileImage: [["path", { d: PAGE }], ["circle", { cx: 6.5, cy: 8, r: 1 }], ["path", { d: "M5 12.5l2.3-2.3a.7.7 0 0 1 1 0L11 12.5" }]],
  FileList: [["path", { d: PAGE }], ["path", { d: "M7 8.5h3.5M7 11h3.5" }], dot(5.5, 8.5, 0.6), dot(5.5, 11, 0.6)],
  FileLock: [["path", { d: PAGE }], ["rect", { x: 5.5, y: 9, width: 5, height: 3.5, rx: 0.8 }], ["path", { d: "M6.75 9V8a1.25 1.25 0 0 1 2.5 0v1" }]],
  FilePdf: [["path", { d: PAGE }], ["path", { d: "M5 12.5V9h1.2a1 1 0 0 1 0 2H5M8 12.5V9h.8a1.5 1.5 0 0 1 0 3.5H8M11.5 12.5V9h1.8M11.5 10.75h1.5" }]],
  Files: [["path", { d: "M6 2.5h4.5l3 3V11a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1zM10.5 2.5v3h3M3 5v8.5a1 1 0 0 0 1 1h7" }]],
  Clipboard: [["path", { d: "M6 2.5h4a1 1 0 0 1 1 1V4H5v-.5a1 1 0 0 1 1-1zM5 4H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1h-1" }]],
  Newspaper: [FRAME, ["path", { d: "M4.5 6h3v3h-3zM9.5 6h2M9.5 8.5h2M4.5 11h7" }]],
  Book: [["path", { d: "M4 2.5h8.5v11H4a1.5 1.5 0 0 1 0-3h8.5M4 2.5A1.5 1.5 0 0 0 2.5 4v8" }]],
  Bookmark: [["path", { d: "M4 2.5h8v11l-4-3-4 3z" }]],
  Library: [["path", { d: "M2.5 3h2.5v10H2.5zM6.5 3H9v10H6.5zM10.5 3.5l2.4-.6 2.4 9.3-2.4.6z" }]],
  Collection: [["path", { d: "M4 6.5h8a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1zM4.5 4.5h7M6 2.5h4" }]],
  CollectionPlus: [["path", { d: "M4 6.5h8a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1zM4.5 4.5h7M6 2.5h4M8 8.25v3M6.5 9.75h3" }]],

  // ---- folders (the plain, open, plus and group ones live in core)
  FolderArrowRightUp: [["path", { d: FOLDER_PART }], ["path", { d: "M9.5 13.5l3.5-3.5M10 10h3v3" }]],
  FolderCheck: [["path", { d: FOLDER_PART }], ["path", { d: "M9 11.5l1.5 1.5 3-3" }]],
  FolderDashed: [["path", { d: FOLDER, strokeDasharray: "2 1.6" }]],
  FolderLibrary: [["path", { d: FOLDER }], ["path", { d: "M5.5 8v3.5M8 8v3.5M10.5 8v3.5" }]],

  // ---- windows and layouts
  Browser: [["rect", { x: 2, y: 2.5, width: 12, height: 11, rx: 1.5 }], ["path", { d: "M2 6h12" }], dot(4.25, 4.25, 0.6), dot(6.25, 4.25, 0.6)],
  Browsers: [["path", { d: "M5 5V3.5a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-1.5" }], ["rect", { x: 2, y: 5, width: 9.5, height: 8.5, rx: 1 }], ["path", { d: "M2 8h9.5" }]],
  Window: [["rect", { x: 2, y: 2.5, width: 12, height: 11, rx: 1.5 }], ["path", { d: "M2 6h12" }]],
  Windows: [["path", { d: "M5.5 5.5V3.5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2" }], ["rect", { x: 2.5, y: 5.5, width: 8, height: 8, rx: 1 }]],
  Tabs: [FRAME, ["path", { d: "M2 6.5h12M6 3v3.5M10 3v3.5" }]],
  FocusWindow: [["rect", { x: 4.5, y: 4.5, width: 7, height: 7, rx: 1 }], ["path", { d: "M2 5V3a1 1 0 0 1 1-1h2M11 2h2a1 1 0 0 1 1 1v2M14 11v2a1 1 0 0 1-1 1h-2M5 14H3a1 1 0 0 1-1-1v-2" }]],
  LayoutEmpty: [FRAME],
  LayoutDialog: [FRAME, ["rect", { x: 5, y: 6, width: 6, height: 4, rx: 0.8 }]],
  LayoutFloatingWindow: [FRAME, ["rect", { x: 7.5, y: 7.5, width: 5, height: 4, rx: 0.8 }]],
  LayoutPanelOff: [FRAME, ["path", { d: "M2 9.5h12" }]],
  LayoutPanelBottomOn: [FRAME, ["path", { d: "M2.5 9.5h11v2a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 11.5z", fill: "currentColor" }]],
  LayoutPanelBottomDock: [FRAME, ["path", { d: "M2 9.5h12M8 5v3M6.5 6.5 8 8l1.5-1.5" }]],
  LayoutPanelBottomUndock: [FRAME, ["path", { d: "M2 9.5h12M8 8V5M6.5 6.5 8 5l1.5 1.5" }]],
  LayoutSidebarLeft: [FRAME, ["path", { d: "M6 3v10" }]],
  LayoutSidebarLeftOn: [FRAME, ["path", { d: "M3.5 3H6v10H3.5A1.5 1.5 0 0 1 2 11.5v-7A1.5 1.5 0 0 1 3.5 3z", fill: "currentColor" }]],
  LayoutSidebarLeftDock: [FRAME, ["path", { d: "M6 3v10M11 8H7.5M9 6.5 7.5 8 9 9.5" }]],
  LayoutSidebarLeftUndock: [FRAME, ["path", { d: "M6 3v10M7.5 8H11M9.5 6.5 11 8l-1.5 1.5" }]],
  LayoutSidebarRight: [FRAME, ["path", { d: "M10 3v10" }]],
  LayoutSidebarRightOn: [FRAME, ["path", { d: "M12.5 3H10v10h2.5a1.5 1.5 0 0 0 1.5-1.5v-7A1.5 1.5 0 0 0 12.5 3z", fill: "currentColor" }]],
  LayoutSidebarRightDock: [FRAME, ["path", { d: "M10 3v10M5 8h3.5M7 6.5 8.5 8 7 9.5" }]],
  LayoutSidebarRightUndock: [FRAME, ["path", { d: "M10 3v10M8.5 8H5M6.5 6.5 5 8l1.5 1.5" }]],
  LayoutSplitHorizontalDashed: [FRAME, ["path", { d: "M8 3v10", strokeDasharray: "2 1.6" }]],
  LayoutSplitHorizontalRightDock: [FRAME, ["path", { d: "M8 3v10M9.5 8h3M11 6.5 12.5 8 11 9.5" }]],
  LayoutSplitHorizontalRightUndock: [FRAME, ["path", { d: "M8 3v10M12.5 8h-3M11 6.5 9.5 8 11 9.5" }]],
  Dashboard: [["rect", { x: 2.5, y: 2.5, width: 5, height: 7, rx: 1 }], ["rect", { x: 9.5, y: 2.5, width: 4, height: 4, rx: 1 }], ["rect", { x: 9.5, y: 8.5, width: 4, height: 5, rx: 1 }], ["rect", { x: 2.5, y: 11.5, width: 5, height: 2, rx: 1 }]],
  BoardKanban: [["path", { d: "M2.5 3.5h3v9h-3zM6.5 3.5h3v6h-3zM10.5 3.5h3v4h-3z" }]],
  Grid: [BOX, ["path", { d: "M2 6h12M2 10h12M6 2v12M10 2v12" }]],
  GridPlus: [["rect", { x: 2.5, y: 2.5, width: 4.5, height: 4.5, rx: 1 }], ["rect", { x: 9, y: 2.5, width: 4.5, height: 4.5, rx: 1 }], ["rect", { x: 2.5, y: 9, width: 4.5, height: 4.5, rx: 1 }], ["path", { d: "M11.25 9.5v4M9.25 11.5h4" }]],
  GridSparkle: [["rect", { x: 2.5, y: 2.5, width: 4.5, height: 4.5, rx: 1 }], ["rect", { x: 9, y: 2.5, width: 4.5, height: 4.5, rx: 1 }], ["rect", { x: 2.5, y: 9, width: 4.5, height: 4.5, rx: 1 }], ["path", { d: "M11.25 9c.2 1.5.8 2.1 2.3 2.3-1.5.2-2.1.8-2.3 2.3-.2-1.5-.8-2.1-2.3-2.3 1.5-.2 2.1-.8 2.3-2.3z" }]],
  SquaresMinus: [["rect", { x: 2.5, y: 2.5, width: 4.5, height: 4.5, rx: 1 }], ["rect", { x: 9, y: 2.5, width: 4.5, height: 4.5, rx: 1 }], ["rect", { x: 2.5, y: 9, width: 4.5, height: 4.5, rx: 1 }], ["path", { d: "M9.25 11.5h4" }]],
  SquaresX: [["rect", { x: 2.5, y: 2.5, width: 4.5, height: 4.5, rx: 1 }], ["rect", { x: 9, y: 2.5, width: 4.5, height: 4.5, rx: 1 }], ["rect", { x: 2.5, y: 9, width: 4.5, height: 4.5, rx: 1 }], ["path", { d: "M9.5 9.75l3.5 3.5M13 9.75l-3.5 3.5" }]],
  Table: [FRAME, ["path", { d: "M2 7h12M2 10h12M6.5 3v10" }]],
  Menu: [["path", { d: "M2.5 4.5h11M2.5 8h11M2.5 11.5h11" }]],
  KebabVertical: [dot(8, 3.5), dot(8, 8), dot(8, 12.5)],
  Gripper: [dot(6, 4), dot(10, 4), dot(6, 8), dot(10, 8), dot(6, 12), dot(10, 12)],
  ListBullets: [["path", { d: "M6 4.5h7.5M6 8h7.5M6 11.5h7.5" }], dot(3, 4.5), dot(3, 8), dot(3, 11.5)],
  ListOrdered: [["path", { d: "M6.5 4.5h7M6.5 8h7M6.5 11.5h7M2.5 3.5l1-.5v3M2.5 9.75a1 1 0 0 1 2 0c0 .8-2 1.3-2 2.25h2" }]],
  ListTodo: [["rect", { x: 2, y: 3, width: 3, height: 3, rx: 0.7 }], ["rect", { x: 2, y: 10, width: 3, height: 3, rx: 0.7 }], ["path", { d: "M7 4.5h6.5M7 11.5h6.5M2.8 4.5l.7.7 1.2-1.4" }]],
  ListTodoSubtask: [["rect", { x: 2, y: 3, width: 3, height: 3, rx: 0.7 }], ["rect", { x: 5, y: 9.5, width: 3, height: 3, rx: 0.7 }], ["path", { d: "M7 4.5h6.5M10 11h3.5M3.5 6.5V9a2 2 0 0 0 1.5 1.9" }]],
  ListX: [["path", { d: "M7 4.5h6.5M7 8h6.5M7 11.5h6.5M2.5 6.5l2.5 2.5M5 6.5 2.5 9" }]],
  Hamburger: [["path", { d: "M2.5 6.5a5.5 3.5 0 0 1 11 0zM2.5 9.5h11M3 11.5v.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5v-.5z" }]],

  // ---- devices and displays
  Laptop: [["path", { d: "M1.5 12h13M3 10V3.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1V10" }]],
  MacMini: [["rect", { x: 2, y: 5, width: 12, height: 6, rx: 1.5 }], dot(4.5, 8, 0.6), ["path", { d: "M10.5 8h1.5" }]],
  Smartwatch: [["rect", { x: 4.5, y: 4.5, width: 7, height: 7, rx: 2 }], ["path", { d: "M6 4.5V2h4v2.5M6 11.5V14h4v-2.5" }]],
  Watch: [["circle", { cx: 8, cy: 8, r: 4 }], ["path", { d: "M8 6v2l1.3.8M6.5 4.3V2h3v2.3M6.5 11.7V14h3v-2.3" }]],
  Vm: [FRAME, ["path", { d: "M4.5 6.5l1.5 3 1.5-3M9.5 9.5v-3l1.25 2 1.25-2v3" }]],
  Vr: [["path", { d: "M2.5 6a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 6v4a1.5 1.5 0 0 1-1.5 1.5h-2L8 9.5l-2 2H4A1.5 1.5 0 0 1 2.5 10z" }]],
  VrHeadset: [["path", { d: "M2.5 6a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 6v4a1.5 1.5 0 0 1-1.5 1.5h-2L8 9.5l-2 2H4A1.5 1.5 0 0 1 2.5 10zM1 7.5h1.5M13.5 7.5H15" }]],
  VrHeadsetHead: [["path", { d: "M3 7a5.5 5.5 0 0 1 10 0M2.5 8.5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-1.5L9.5 10h-3L5 11.5H3.5a1 1 0 0 1-1-1z" }]],
  RemoteControl: [["rect", { x: 5, y: 1.5, width: 6, height: 13, rx: 1.5 }], dot(7, 4, 0.6), dot(9, 4, 0.6), ["path", { d: "M7 7h2M7 9.5h2M7 12h2" }]],
  DisplayCheck: [["path", { d: MONITOR }], ["path", { d: "M5.5 7l1.8 1.8L10.5 5" }]],
  DisplayCircle: [["path", { d: MONITOR }], ["circle", { cx: 8, cy: 7, r: 2 }]],
  DisplayConnect: [["path", { d: MONITOR }], ["path", { d: "M5.5 7h5M9 5.5 10.5 7 9 8.5" }]],
  DisplayPlay: [["path", { d: MONITOR }], ["path", { d: "M6.5 5v4l3.5-2z", fill: "currentColor" }]],
  DisplayWaves: [["path", { d: MONITOR }], ["path", { d: "M4 7.5c1.3-2 2.7-2 4 0s2.7 2 4 0" }]],
  Displays: [["path", { d: "M5 10.5H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" }], ["rect", { x: 6.5, y: 6.5, width: 8, height: 6, rx: 1 }], ["path", { d: "M9.5 14.5h2M10.5 12.5v2" }]],
  Camera: [["path", { d: "M2.5 6a1 1 0 0 1 1-1h2l1-1.5h3l1 1.5h2a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" }], ["circle", { cx: 8, cy: 8.5, r: 2.25 }]],
  VideoCamera: [["rect", { x: 2, y: 4.5, width: 8.5, height: 7, rx: 1.5 }], ["path", { d: "M10.5 7.5 14 5.5v5l-3.5-2" }]],
  FilmStrip: [["rect", { x: 2, y: 2.5, width: 12, height: 11, rx: 1.5 }], ["path", { d: "M2 5.5h12M2 10.5h12M5 2.5v3M8 2.5v3M11 2.5v3M5 10.5v3M8 10.5v3M11 10.5v3" }]],
  FilmReel: [["circle", { cx: 8, cy: 8, r: 5.75 }], ["circle", { cx: 8, cy: 8, r: 1.25 }], ["circle", { cx: 8, cy: 4.75, r: 1 }], ["circle", { cx: 11.25, cy: 8, r: 1 }], ["circle", { cx: 8, cy: 11.25, r: 1 }], ["circle", { cx: 4.75, cy: 8, r: 1 }]],
  ImageSquare: [BOX, ["circle", { cx: 5.75, cy: 5.75, r: 1 }], ["path", { d: "M2.5 12l3.3-3.3a1 1 0 0 1 1.4 0L10.5 12M9 10.5l1.3-1.3a1 1 0 0 1 1.4 0L13.5 11" }]],
  Chip: [["rect", { x: 4, y: 4, width: 8, height: 8, rx: 1.5 }], ["rect", { x: 6.5, y: 6.5, width: 3, height: 3, rx: 0.5 }], ["path", { d: "M6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5" }]],
  ChipSimple: [["rect", { x: 4, y: 4, width: 8, height: 8, rx: 1.5 }], ["path", { d: "M6 1.5V4M10 1.5V4M6 12v2.5M10 12v2.5M1.5 6H4M1.5 10H4M12 6h2.5M12 10h2.5" }]],
  KeyboardTab: [["path", { d: "M2.5 8h9M9 5.5 11.5 8 9 10.5M13.5 4.5v7" }]],
  Cd: [["circle", { cx: 8, cy: 8, r: 5.75 }], ["circle", { cx: 8, cy: 8, r: 1.5 }], ["path", { d: "M4.5 8a3.5 3.5 0 0 1 3.5-3.5" }]],
  Tray: [["path", { d: "M2.5 8.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3M2.5 8.5h3l1 1.5h3l1-1.5h3M2.5 8.5 4 3.5h8l1.5 5" }]],
  Zipper: [["path", { d: "M8 1.5v10M6 3.5h4M6 6h4M6 8.5h4M6.5 11.5h3v2.5h-3z" }]],
  Package: [["path", { d: "M8 2 2.5 5v6L8 14l5.5-3V5zM2.5 5 8 8l5.5-3M8 8v6M5.25 3.5l5.5 3" }]],
  Cube: [["path", { d: "M8 2 2.5 5v6L8 14l5.5-3V5zM2.5 5 8 8l5.5-3M8 8v6" }]],
  CubeTransparent: [["path", { d: "M8 2 2.5 5v6L8 14l5.5-3V5z" }], ["path", { d: "M2.5 5 8 8l5.5-3M8 8v6M8 8 2.5 11M8 8l5.5 3", strokeDasharray: "1.5 1.5" }]],
  CubeCoordinates: [["path", { d: "M8 2 2.5 5v6L8 14l5.5-3V5zM2.5 5 8 8l5.5-3M8 8v6" }], dot(8, 8, 1)],
  CubeNodes: [["path", { d: "M8 3.5 4 5.75v4.5L8 12.5l4-2.25v-4.5z" }], dot(8, 2, 0.9), dot(2.5, 5.5, 0.9), dot(13.5, 5.5, 0.9), dot(8, 14, 0.9)],
  Cylinder: [["path", { d: "M13 4c0 1.1-2.2 2-5 2S3 5.1 3 4s2.2-2 5-2 5 .9 5 2zM3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" }]],
  DatabaseNetwork: [["path", { d: "M11 4c0 .8-1.6 1.5-3.5 1.5S4 4.8 4 4s1.6-1.5 3.5-1.5S11 3.2 11 4zM4 4v3c0 .8 1.6 1.5 3.5 1.5S11 7.8 11 7V4M7.5 8.5V11M4.5 13.5V11h6v2.5" }], dot(4.5, 14, 0.7), dot(10.5, 14, 0.7)],
  Server: [["rect", { x: 2, y: 2.5, width: 12, height: 4.5, rx: 1 }], ["rect", { x: 2, y: 9, width: 12, height: 4.5, rx: 1 }], dot(4.5, 4.75, 0.7), dot(4.5, 11.25, 0.7)],
  Servers: [["rect", { x: 2, y: 2, width: 12, height: 3, rx: 0.8 }], ["rect", { x: 2, y: 6.5, width: 12, height: 3, rx: 0.8 }], ["rect", { x: 2, y: 11, width: 12, height: 3, rx: 0.8 }], dot(4.25, 3.5, 0.6), dot(4.25, 8, 0.6), dot(4.25, 12.5, 0.6)],
  CloudUpload: [["path", { d: "M4.75 11.5a3.25 3.25 0 0 1-.5-6.46A4.5 4.5 0 0 1 12.9 5.5a3 3 0 0 1 .3 5.9M8 14.5V8M5.5 10.5 8 8l2.5 2.5" }]],
  ChatBubblesGrid: [["path", { d: bubble(2, 2) }], ["path", { d: bubble(8.5, 2) }], ["path", { d: bubble(2, 8.5) }], ["path", { d: bubble(8.5, 8.5) }]],
};
