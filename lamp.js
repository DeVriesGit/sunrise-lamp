// The lamp's protocol and the sunrise alarm - pure functions, no browser, so Node tests them.
//
// A straight port of the Android app's Protocol.kt and Alarm.kt (v0.2.0), whose output was
// WATCHED firing on the lamp on 24 Oct 2026. Every byte here was measured on the .78 bulb
// (docs/protocol-findings.md in the project). Do not "tidy" a value without re-measuring it.
//
// The commands are the SAME bytes Smart Home sends over Wi-Fi. Over Bluetooth each is wrapped
// in an 8-byte envelope; the lamp answers with an 8-byte header + JSON carrying the Wi-Fi reply
// as hex: {"code":0,"payload":"81352361..."}.

// ---- Bluetooth identifiers ------------------------------------------------------------------
export const SERVICE = 0xffff;       // NOT advertised - must be listed in optionalServices
export const WRITE_CHAR = 0xff01;    // commands in
export const NOTIFY_CHAR = 0xff02;   // replies out
export const NAME_PREFIX = "IOTW";   // these bulbs advertise IOTWxxxx (ours: IOTWF1F3)

const KIND_WITH_REPLY = 0x0a;        // envelope kind: 0x0A gets a reply, 0x0B got none
export const HEADER = 8;

// ---- commands (inner, unwrapped) ------------------------------------------------------------

export const QUERY_STATE = [0x81, 0x8a, 0x8b, 0x96];   // checksum included
export const QUERY_TIMERS = [0x22, 0x2a, 0x2b, 0x0f];  // trailing 0x0F is a flag; the reply echoes it

export function withChecksum(...b) {
  return [...b, b.reduce((s, x) => s + x, 0) & 0xff];
}

export function power(on) {
  return withChecksum(0x71, on ? 0x23 : 0x24, 0x0f);
}

// Colour and white (measured, Smart Home docs/protocol-findings.md; and on this lamp 25 Oct 2026).
// One command, 31 R G B WW CW <mask> 0F: mask F0 writes ONLY the colour channels, 0F ONLY the whites.
// Any of these also ends a built-in effect (the factory-reset lamp ran mode 0x63 until one was sent).
export function setColour(r, g, b) { return withChecksum(0x31, r, g, b, 0, 0, 0xf0, 0x0f); }
export function setWhite(warm, cool) { return withChecksum(0x31, 0, 0, 0, warm, cool, 0x0f, 0x0f); }

// The commands for a colour, or for a white. Going to white the colour channels must be zeroed first,
// or the lamp stays tinted; going to colour the whites must be zeroed, or the colour is washed out.
export function colourCommands(r, g, b) { return [setWhite(0, 0), setColour(r, g, b)]; }
export function whiteCommands(warm, cool) { return [setColour(0, 0, 0), setWhite(warm, cool)]; }

// Hue 0-360, saturation 0-1 -> the fully bright RGB of that colour.
export function hueToRgb(h, s) {
  const f = (n) => { const k = (n + h / 60) % 6; return 1 - s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5), f(3), f(1)].map((v) => Math.round(v * 255));
}
// RGB -> hue 0-360, saturation 0-1 and brightness 0-1 (the brightest channel, as Smart Home reads it).
export function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max / 255 };
}
// A colour at a brightness (0-1): every channel scaled alike, so the hue stays (Smart Home scaleColour).
export function atBrightness([r, g, b], level) {
  const k = Math.max(1, Math.round(level * 255)) / 255;
  return [r, g, b].map((c) => Math.round(c * k));
}
// A white at a brightness (0-1) and warmth (0 = all warm, 1 = all cool); warm + cool = the level.
export function whiteAt(level, coolShare) {
  const total = Math.max(1, Math.round(level * 255));
  const cool = Math.round(total * coolShare);
  return [total - cool, cool];
}

// Set the lamp's clock - sent on every connect: the alarm runs on it, and these bulbs lose the
// time at every power cut. Day of week is ISO (1 = Monday ... 7 = Sunday), measured.
export function setClock(d) {
  const isoDay = d.getDay() === 0 ? 7 : d.getDay();
  return withChecksum(0x10, 0x14, d.getFullYear() - 2000, d.getMonth() + 1, d.getDate(),
    d.getHours(), d.getMinutes(), d.getSeconds(), isoDay, 0x00, 0x0f);
}

// ---- timer slots ----------------------------------------------------------------------------
// 15 bytes each, measured:
//   [0] F0 active / 00 unused   [1..3] date (0 when repeating)   [4] hour  [5] minute
//   [6] seconds - ALWAYS 0 (a non-zero second never fires)       [7] repeat mask
//   [8] 61 static colour  [9..11] R G B  [12] warm  [13] cool  [14] F0 = switch ON

export const SLOT_SIZE = 15;
export const SLOT_COUNT = 6;
export const EMPTY = { active: false, hour: 0, minute: 0, days: 0, warm: 0, cool: 0, turnsOn: true };

export function slotBytes(s) {
  if (!s.active) return new Array(SLOT_SIZE).fill(0);
  return [0xf0, 0, 0, 0, s.hour, s.minute, 0, s.days, 0x61, 0, 0, 0, s.warm, s.cool,
    s.turnsOn ? 0xf0 : 0x0f];    // 0x0F to switch off - NEVER 0x00, which stores but never fires
}

export function slotFrom(b, at) {
  if (b[at] !== 0xf0) return { ...EMPTY };
  return { active: true, hour: b[at + 4], minute: b[at + 5], days: b[at + 7],
    warm: b[at + 12], cool: b[at + 13], turnsOn: b[at + 14] === 0xf0 };
}

// Write all six slots at once - there is no way to write just one.
export function setTimers(slots) {
  if (slots.length > SLOT_COUNT) throw new Error(`at most ${SLOT_COUNT} timers`);
  const body = [0x21];
  for (let i = 0; i < SLOT_COUNT; i++) body.push(...slotBytes(slots[i] ?? EMPTY));
  body.push(0x00, 0xf0);
  return [...body, body.reduce((s, x) => s + x, 0) & 0xff];
}

// The six slots out of a timer reply payload (0F 22 <6 x 15 bytes> ...); null if not one.
export function parseTimers(p) {
  if (p.length < 2 + SLOT_SIZE * SLOT_COUNT || p[1] !== 0x22) return null;
  return Array.from({ length: SLOT_COUNT }, (_, i) => slotFrom(p, 2 + i * SLOT_SIZE));
}

// ---- envelope -------------------------------------------------------------------------------

export function wrap(seq, inner) {
  return [0x00, seq & 0xff, 0x80, 0x00, 0x00, inner.length, inner.length + 1, KIND_WITH_REPLY, ...inner];
}

// The hex payload out of one complete reply (header + JSON); null if it is not one or the lamp
// reported a non-zero code.
export function payloadOf(reply) {
  if (reply.length <= HEADER) return null;
  const json = String.fromCharCode(...reply.slice(HEADER));
  const code = json.match(/"code"\s*:\s*(-?\d+)/);
  if (!code || Number(code[1]) !== 0) return null;
  const hex = json.match(/"payload"\s*:\s*"([0-9A-Fa-f]*)"/);
  return hex ? hexToBytes(hex[1]) : null;
}

// Two shapes arrive:
//  81 ...    - answer to QUERY_STATE: power at 2, mode at 3 (0x61 static), RGB at 6-8, warm 9, cool 11.
//  EA 81 ... - pushed after a command: power at byte 6; whites not decoded -> null, not guessed.
export function parseState(p) {
  if (p.length >= 14 && p[0] === 0x81)
    return { on: p[2] === 0x23, mode: p[3], red: p[6], green: p[7], blue: p[8], warm: p[9], cool: p[11] };
  if (p.length >= 7 && p[0] === 0xea && p[1] === 0x81) return { on: p[6] === 0x23, warm: null, cool: null };
  return null;
}

export function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}

// Glues notification packets back into whole replies. A reply (59 bytes for a state) can arrive
// in 20-byte pieces if the phone did not negotiate a bigger packet. Header byte 5 = JSON length.
export class ReplyAssembler {
  constructor() { this.buffer = []; this.expected = 0; }
  feed(packet) {
    if (this.buffer.length === 0) {
      if (packet.length < HEADER || packet[0] !== 0x04) return null;   // not a reply start
      this.expected = HEADER + packet[5];
    }
    this.buffer.push(...packet);
    const done = this.buffer.length >= this.expected || this.buffer[this.buffer.length - 1] === 0x7d; // '}'
    if (!done) return null;
    const out = this.buffer;
    this.buffer = [];
    return out;
  }
}

// ---- days -----------------------------------------------------------------------------------
// Repeat mask: Su=01 Mo=02 Tu=04 We=08 Th=10 Fr=20 Sa=40 (measured, Smart Home).

export const Days = {
  SUN: 0x01, MON: 0x02, SAT: 0x40, WEEKDAYS: 0x3e, ALL: 0x7f,
  MONDAY_FIRST: [[0x02, "Mon"], [0x04, "Tue"], [0x08, "Wed"], [0x10, "Thu"], [0x20, "Fri"], [0x40, "Sat"], [0x01, "Sun"]],
  // The same days one day earlier - a Monday 00:02 alarm starts brightening on SUNDAY 23:57.
  dayBefore: (m) => ((m >> 1) | ((m & 0x01) << 6)) & 0x7f,
  describe(m) {
    m &= 0x7f;
    if (m === 0x7f) return "every day";
    if (m === 0x3e) return "Mon–Fri";
    if (m === 0x41) return "weekends";
    if (m === 0) return "no days";
    return Days.MONDAY_FIRST.filter(([bit]) => m & bit).map(([, n]) => n).join(" ");
  },
};

// ---- the alarm ------------------------------------------------------------------------------
// One time + the days it repeats. The lamp brightens over the 5 minutes BEFORE the time and is
// fully cool white exactly AT it (grill Q9, Q10), then stays on.

export const STEPS = SLOT_COUNT;   // one step per minute uses all six slots
const DAY_MIN = 24 * 60;

export const clock = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function alarmSlots(a) {
  const mins = a.hour * 60 + a.minute;
  const slots = [];
  for (let i = 0; i < STEPS; i++) {
    const fraction = (i + 1) / STEPS;
    // Gamma 2.2: evenly spaced PWM looks like a light snapping on. Kotlin did this in 32-bit
    // Float; Math.fround keeps the same rounding so the bytes match the slots measured in the lamp.
    const f = Math.fround(fraction);
    const level = Math.max(1, Math.round(Math.fround(255 * Math.fround(Math.pow(f, 2.2)))));
    const cool = Math.min(255, Math.max(0, Math.round(Math.fround(level * f))));
    const warm = Math.min(255, Math.max(0, level - cool));
    let t = mins - (STEPS - 1 - i);
    let days = a.days;
    if (t < 0) { t += DAY_MIN; days = Days.dayBefore(a.days); }   // step falls before midnight
    slots.push({ active: true, hour: Math.floor(t / 60), minute: t % 60, days, warm, cool, turnsOn: true });
  }
  return slots;
}

export const alarmTime = (a) => clock(a.hour * 60 + a.minute);
export const rampStart = (a) => clock((a.hour * 60 + a.minute - (STEPS - 1) + DAY_MIN) % DAY_MIN);

// Compared on time, days and action ONLY - never white values: the lamp snaps white to its own
// grid, and a retry on a white mismatch loops for ever (Smart Home rule).
export function sameSchedule(actual, expected) {
  return actual.length === expected.length && actual.every((s, i) => {
    const e = expected[i];
    return s.active === e.active && s.hour === e.hour && s.minute === e.minute &&
      s.days === e.days && s.turnsOn === e.turnsOn;
  });
}

// What the lamp's timers hold: {kind:"none"}, {kind:"set", alarm}, or {kind:"foreign"} (timers
// another app wrote, e.g. Smart Home - saving an alarm replaces them).
export function readAlarm(slots) {
  if (!slots.some((s) => s.active)) return { kind: "none" };
  const last = slots[slots.length - 1];
  if (!last || !last.active || last.days === 0) return { kind: "foreign" };
  const alarm = { hour: last.hour, minute: last.minute, days: last.days };
  return sameSchedule(slots, alarmSlots(alarm)) ? { kind: "set", alarm } : { kind: "foreign" };
}
