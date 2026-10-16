/**
 * People, agents, conversation, sound and signals: who is talking and how.
 */
import { BOX, RING, dot, type Glyph } from "./shared";

/** A round speech bubble, tail at the lower left. */
const ROUND_BUBBLE = "M8 13.5a5.75 5.75 0 1 0-5.1-3.1L2.25 13.75l3.4-.7A5.7 5.7 0 0 0 8 13.5z";
/** A square speech bubble, tail at the lower left. */
const SQUARE_BUBBLE = "M2.5 4A1.5 1.5 0 0 1 4 2.5h8A1.5 1.5 0 0 1 13.5 4v6a1.5 1.5 0 0 1-1.5 1.5H6l-3.5 2.5z";
/** The eyes every smiley shares. */
const EYES: Glyph = [dot(6, 6.5, 0.8), dot(10, 6.5, 0.8)];
/** A speaker cone, for mute and unmute. */
const SPEAKER = "M2.5 6.5h2L8 3.5v9l-3.5-3h-2z";
/** The thumb of thumbs up, drawn once. */
const THUMB = "M4.5 7.5v6M4.5 7.5h-1.5a.5.5 0 0 0-.5.5v5a.5.5 0 0 0 .5.5h1.5M4.5 7.5l3-5a1.5 1.5 0 0 1 2.5 1.2L9.5 6.5h3a1.5 1.5 0 0 1 1.5 1.7l-.8 4.5a1.5 1.5 0 0 1-1.5 1.3H4.5";

export const GLYPHS: Record<string, Glyph> = {
  // ---- people
  Account: [RING, ["circle", { cx: 8, cy: 6.5, r: 2 }], ["path", { d: "M4.3 12.3a4 4 0 0 1 7.4 0" }]],
  People3: [["circle", { cx: 8, cy: 4.5, r: 2 }], ["circle", { cx: 3.5, cy: 6.5, r: 1.6 }], ["circle", { cx: 12.5, cy: 6.5, r: 1.6 }], ["path", { d: "M4.5 13.5a3.5 3.5 0 0 1 7 0M1.5 12a2.5 2.5 0 0 1 2.5-2.5M14.5 12a2.5 2.5 0 0 0-2.5-2.5" }]],
  PersonChatBubble: [["circle", { cx: 5.5, cy: 5.5, r: 2.5 }], ["path", { d: "M1.5 13.5a4 4 0 0 1 8 0M9.5 4a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2.5a1 1 0 0 1-1 1H12L10.5 9V7.5a1 1 0 0 1-1-1z" }]],

  // ---- agents
  Agent: [["path", { d: "M8 1.5l5.5 12-5.5-2.5-5.5 2.5z" }]],
  AgentCircle: [RING, ["path", { d: "M8 4.5l3 6.5-3-1.3-3 1.3z" }]],
  AgentSquare: [BOX, ["path", { d: "M8 4.5l3 6.5-3-1.3-3 1.3z" }]],
  Agents: [["path", { d: "M5.5 1.5l4 9-4-1.8-4 1.8zM10.5 6.5l3.5 8-3.5-1.5-3.5 1.5z" }]],
  AgentsSwarm: [["path", { d: "M3 4l5 3 5-3M8 7v5" }], dot(3, 4, 1.1), dot(13, 4, 1.1), dot(8, 12, 1.1), dot(8, 7, 1.1)],

  // ---- conversation (the plain bubbles live in core)
  ChatBubblePencil: [["path", { d: ROUND_BUBBLE }], ["path", { d: "M6 10l.5-2 3.4-3.4a1 1 0 0 1 1.4 1.4L7.9 9.4z" }]],
  ChatBubbleChevronsLeftRight: [["path", { d: ROUND_BUBBLE }], ["path", { d: "M6.5 6.5 5 8l1.5 1.5M9.5 6.5 11 8 9.5 9.5" }]],
  ChatBubbles: [["path", { d: "M9.5 5a3.5 3.5 0 0 0-7 0 3.5 3.5 0 0 0 .6 1.9L2.5 9l2.3-.5A3.5 3.5 0 0 0 9.5 5zM10.5 7.5a3.5 3.5 0 0 1-1 6.4l2.3.6-.3-2.3A3.5 3.5 0 0 0 10.5 7.5" }]],
  CommentDashed: [["path", { d: SQUARE_BUBBLE, strokeDasharray: "2 1.6" }]],
  CommentDot: [["path", { d: SQUARE_BUBBLE }], dot(8, 7, 1.3)],
  Feedback: [["path", { d: SQUARE_BUBBLE }], ["path", { d: "M8 4.3l.9 1.8 2 .3-1.4 1.4.3 2-1.8-.9-1.8.9.3-2-1.4-1.4 2-.3z" }]],
  Megaphone: [["path", { d: "M2.5 6.5v3a1 1 0 0 0 1 1H5l5.5 3V2.5L5 5.5H3.5a1 1 0 0 0-1 1zM12.5 6a2.5 2.5 0 0 1 0 4M5 10.5l1 3" }]],
  Envelope: [["rect", { x: 1.5, y: 3.5, width: 13, height: 9, rx: 1.5 }], ["path", { d: "M1.5 5.5 8 9.5l6.5-4" }]],
  EnvelopeOpen: [["path", { d: "M1.5 7l6.5-4.5L14.5 7v6a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1zM1.5 7l6.5 4 6.5-4" }]],
  ThumbsUp: [["path", { d: THUMB }]],
  ThumbsDown: [["path", { d: THUMB, transform: "rotate(180 8 8)" }]],

  // ---- faces
  SmileyHappy: [RING, ["path", { d: "M5.5 9.5a3 3 0 0 0 5 0" }], ...EYES],
  SmileyNeutral: [RING, ["path", { d: "M5.5 10h5" }], ...EYES],
  SmileySad: [RING, ["path", { d: "M5.5 10.75a3 3 0 0 1 5 0" }], ...EYES],
  SmileyHappySquare: [BOX, ["path", { d: "M5.5 9.5a3 3 0 0 0 5 0" }], ...EYES],
  SmileyPlus: [["circle", { cx: 7, cy: 9, r: 5 }], ["path", { d: "M4.8 10.3a2.8 2.8 0 0 0 4.4 0M12.5 1.5v4M10.5 3.5h4" }], dot(5.5, 7.8, 0.7), dot(8.5, 7.8, 0.7)],
  MaskHappy: [["path", { d: "M3 3.5c1.5-.8 3.3-1 5-1s3.5.2 5 1v4.5c0 3.5-2.5 6-5 6s-5-2.5-5-6zM5.5 9a2.8 2.8 0 0 0 5 0" }], ...EYES],
  MasksHappy: [["path", { d: "M1.5 3c1-.5 2-.7 3.3-.7s2.3.2 3.2.7v3.5c0 2.5-1.5 4.5-3.2 4.5S1.5 9 1.5 6.5zM3.2 6.5a1.7 1.7 0 0 0 3.2 0M8 6.5c1-.5 2-.7 3.3-.7s2.3.2 3.2.7V10c0 2.5-1.5 4.5-3.2 4.5S8 12.5 8 10zM9.7 10a1.7 1.7 0 0 0 3.2 0" }]],
  Owl: [["path", { d: "M8 14.5c-3 0-5-2.5-5-6V4.5l2-2 1.5 1.5h3L11 2.5l2 2v4c0 3.5-2 6-5 6zM7.5 9.5 8 10.5l.5-1" }], ["circle", { cx: 6, cy: 7, r: 1.5 }], ["circle", { cx: 10, cy: 7, r: 1.5 }]],
  Pug: [["path", { d: "M4 5.5c0-2 1.8-3 4-3s4 1 4 3v4c0 2.5-1.8 4-4 4s-4-1.5-4-4zM4 5.5 2 4v4l2 1M12 5.5 14 4v4l-2 1M7 10.5h2" }], dot(6.5, 7.5, 0.8), dot(9.5, 7.5, 0.8)],
  Elephant: [["path", { d: "M3.5 4.5a4 4 0 0 1 8 0v5.5H9.5V7M3.5 4.5V8a1.5 1.5 0 0 1-1.5 1.5v1A2.5 2.5 0 0 0 4.5 8M7.5 10v3.5M11.5 6.5h2" }], dot(8.5, 5, 0.7)],
  Paw: [dot(5, 4.5, 1.3), dot(8, 3, 1.3), dot(11, 4.5, 1.3), ["path", { d: "M8 7c2.3 0 4 1.8 4 3.8 0 1.5-1.2 2.7-2.8 2.7-.5 0-.9-.2-1.2-.4-.3.2-.7.4-1.2.4C5.2 13.5 4 12.3 4 10.8 4 8.8 5.7 7 8 7z" }]],

  // ---- sound
  Headphones: [["path", { d: "M2.5 11V8a5.5 5.5 0 0 1 11 0v3" }], ["rect", { x: 2.5, y: 9.5, width: 3, height: 4, rx: 1 }], ["rect", { x: 10.5, y: 9.5, width: 3, height: 4, rx: 1 }]],
  Headset: [["path", { d: "M2.5 11V8a5.5 5.5 0 0 1 11 0v3M10.5 13.5H9" }], ["rect", { x: 2.5, y: 9.5, width: 3, height: 4, rx: 1 }], ["rect", { x: 10.5, y: 9.5, width: 3, height: 4, rx: 1 }]],
  SpeakerHifi: [["rect", { x: 3, y: 1.5, width: 10, height: 13, rx: 1.5 }], ["circle", { cx: 8, cy: 10, r: 2.5 }], ["circle", { cx: 8, cy: 5, r: 1 }]],
  Music: [["path", { d: "M6 12.5V4l7-1.5V11" }], ["circle", { cx: 4, cy: 12.5, r: 2 }], ["circle", { cx: 11, cy: 11, r: 2 }]],
  Waveform: [["path", { d: "M1.5 7v2M4 4.5v7M6.5 2.5v11M9 5.5v5M11.5 3.5v9M14 7v2" }]],
  Mute: [["path", { d: SPEAKER }], ["path", { d: "M11 6.5l3 3M14 6.5l-3 3" }]],
  Unmute: [["path", { d: SPEAKER }], ["path", { d: "M10.5 5.5a3.5 3.5 0 0 1 0 5M12.5 3.5a6 6 0 0 1 0 9" }]],

  // ---- signals
  RadioTower: [["path", { d: "M8 8.5v6M5.5 5.5a3.5 3.5 0 0 1 5 0M3.5 3.5a6.5 6.5 0 0 1 9 0M5.5 14.5 8 8.5l2.5 6" }], dot(8, 7.5, 1)],
  Signal: [["path", { d: "M2.5 13.5v-2M5.5 13.5v-4.5M8.5 13.5v-7M11.5 13.5V4M14 13.5V2.5" }]],
  Bluetooth: [["path", { d: "M4.5 4.5l7 5.5L8 13V3l3.5 3.5-7 5" }]],
  Satellite: [["path", { d: "M6.5 5.5l4 4M9.5 3.5l3 3-2 2-3-3zM4.5 8.5l3 3-2 2-3-3zM2.5 13.5l2-2M11 2.5a2.5 2.5 0 0 1 2.5 2.5" }]],
  Radar: [["path", { d: "M8 8 11.5 4.5M8 2.25a5.75 5.75 0 1 1-5.75 5.75M8 5.5a2.5 2.5 0 1 0 2.5 2.5" }], dot(8, 8, 0.8)],
  Rss: [["path", { d: "M3 8.5a4.5 4.5 0 0 1 4.5 4.5M3 4a9 9 0 0 1 9 9" }], dot(3.5, 12.5, 1)],

  // ---- playback
  PlayCircle: [RING, ["path", { d: "M6.5 5.5v5l4-2.5z", fill: "currentColor" }]],
  PauseCircle: [RING, ["path", { d: "M6.5 5.5v5M9.5 5.5v5" }]],
  PlaySlow: [["path", { d: "M5.5 3.2v9.6a.5.5 0 0 0 .76.43l7.7-4.8a.5.5 0 0 0 0-.86l-7.7-4.8a.5.5 0 0 0-.76.43zM2 8h1.5" }]],
  PlaySuperFast: [["path", { d: "M6 3.2v9.6a.5.5 0 0 0 .76.43l7.2-4.8a.5.5 0 0 0 0-.86l-7.2-4.8A.5.5 0 0 0 6 3.2zM1.5 5h2M1.5 8h2.5M1.5 11h2" }]],
  FastForward: [["path", { d: "M2 4v8l5-4zM8 4v8l5-4z" }]],
  FastBackward: [["path", { d: "M14 4v8L9 8zM8 4v8L3 8z" }]],
};
