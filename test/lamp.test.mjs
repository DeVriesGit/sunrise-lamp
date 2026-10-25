// Run:  node --test test/
// Every expected value is a byte string captured from the real lamp on 24 Oct 2026 - the same
// cases as the Android app's ProtocolTest + AlarmTest. They encode facts no documentation
// carries: keep them.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as L from "../lamp.js";

const hex = (s) => L.hexToBytes(s.replace(/ /g, ""));
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

// ---- protocol ----

test("state query wraps exactly as the bulb accepted it", () => {
  assert.deepEqual(L.wrap(3, L.QUERY_STATE), hex("00 03 80 00 00 04 05 0a 81 8a 8b 96"));
});

test("power commands match the bytes that switched the lamp", () => {
  assert.deepEqual(L.power(false), hex("71 24 0f a4"));
  assert.deepEqual(L.power(true), hex("71 23 0f a3"));
});

test("clock command matches the one the lamp read back correctly", () => {
  // Saturday 24 Oct 2026 22:43:12 - the lamp then reported 22:43:13, day 6.
  const sent = L.setClock(new Date(2026, 9, 24, 22, 43, 12));
  assert.deepEqual(sent, L.withChecksum(0x10, 0x14, 0x1a, 0x0a, 0x18, 0x16, 0x2b, 0x0c, 0x06, 0x00, 0x0f));
  assert.equal(sent.length, 12);
});

test("a Sunday is ISO day 7, not 0", () => {
  assert.equal(L.setClock(new Date(2026, 9, 25, 8, 0, 0))[8], 7);
});

test("sequence counter wraps at one byte", () => {
  assert.equal(L.wrap(256, L.QUERY_STATE)[1], 0x00);
});

test("measured state reply decodes to ON warm 0 cool 255", () => {
  const reply = [...hex("040180000033340a"), ...ascii('{"code":0,"payload":"813523613038000000000AFF0FBA"}')];
  assert.deepEqual(L.parseState(L.payloadOf(reply)), { on: true, mode: 0x61, red: 0, green: 0, blue: 0, warm: 0, cool: 255 });
});

test("pushed EA81 status after OFF reads as off with whites unknown", () => {
  assert.deepEqual(L.parseState(hex("EA810200350A24611C380F000000646400000000")), { on: false, warm: null, cool: null });
  assert.equal(L.parseState(hex("EA810200350A23611C380F000000646400000000")).on, true);
});

test("non-zero code is not a payload", () => {
  assert.equal(L.payloadOf([...hex("040180000010110a"), ...ascii('{"code":1,"payload":"81"}')]), null);
});

test("reply split into 20-byte packets is reassembled", () => {
  const whole = [...hex("040180000033340a"), ...ascii('{"code":0,"payload":"813523613038000000000AFF0FBA"}')];
  assert.equal(whole.length, 59);
  const a = new L.ReplyAssembler();
  const r = [whole.slice(0, 20), whole.slice(20, 40), whole.slice(40)].map((p) => a.feed(p));
  assert.equal(r[0], null); assert.equal(r[1], null);
  assert.deepEqual(r[2], whole);
});

test("stray packet that is not a reply start is ignored", () => {
  assert.equal(new L.ReplyAssembler().feed(hex("0102030405060708090a")), null);
});

test("white command is the one that took the reset lamp out of its effect", () => {
  // Sent 25 Oct 2026: zero RGB, then full warm white -> mode 0x61, held for 60 s.
  assert.deepEqual(L.whiteCommands(255, 0), [hex("31 00 00 00 00 00 f0 0f 30"), hex("31 00 00 00 ff 00 0f 0f 4e")]);
});

test("colour command writes only the colour channels after zeroing the whites", () => {
  assert.deepEqual(L.colourCommands(0, 0, 255), [hex("31 00 00 00 00 00 0f 0f 4f"), hex("31 00 00 ff 00 00 f0 0f 2f")]);
});

test("the measured effect-mode state reads mode 0x63 and its colour", () => {
  const s = L.parseState(hex("813523633038ffffff000a00f09b"));
  assert.equal(s.mode, 0x63);
  assert.deepEqual([s.red, s.green, s.blue], [255, 255, 255]);
});

test("colour maths: hue round-trips and brightness keeps the hue", () => {
  assert.deepEqual(L.hueToRgb(0, 1), [255, 0, 0]);
  assert.deepEqual(L.hueToRgb(240, 1), [0, 0, 255]);
  assert.deepEqual(L.hueToRgb(120, 0), [255, 255, 255]);
  const { h, s, v } = L.rgbToHsv(...L.atBrightness(L.hueToRgb(30, 0.5), 0.5));
  assert.ok(Math.abs(h - 30) < 2 && Math.abs(s - 0.5) < 0.02 && Math.abs(v - 0.5) < 0.01);
  assert.deepEqual(L.whiteAt(1, 0), [255, 0]);
  assert.deepEqual(L.whiteAt(0.5, 0.5), [64, 64]);
});

// ---- alarm ----

// The six slots Smart Home's sunrise had stored in the lamp - a 05:26 weekday alarm.
const measuredPayload = hex(
  "0F22" +
  "F00000000515003E610000000401F0" +
  "F00000000516003E610000000F08F0" +
  "F00000000517003E610000001B1CF0" +
  "F00000000518003E610000002346F0" +
  "F00000000519003E610000001C8FF0" +
  "F0000000051A003E6100000000FFF0" +
  "00A4");

test("a 05:26 weekday alarm produces exactly the slots measured in the lamp", () => {
  const mine = L.setTimers(L.alarmSlots({ hour: 5, minute: 26, days: L.Days.WEEKDAYS }));
  assert.deepEqual(mine.slice(1, 91), measuredPayload.slice(2, 92));
});

test("measured timer reply is recognised as a 05:26 weekday alarm", () => {
  assert.deepEqual(L.readAlarm(L.parseTimers(measuredPayload)),
    { kind: "set", alarm: { hour: 5, minute: 26, days: L.Days.WEEKDAYS } });
});

test("ramp starts five minutes before and ends fully cool at the alarm", () => {
  const s = L.alarmSlots({ hour: 6, minute: 30, days: L.Days.WEEKDAYS });
  assert.deepEqual(s.map((x) => x.minute), [25, 26, 27, 28, 29, 30]);
  assert.deepEqual([s[5].warm, s[5].cool], [0, 255]);
  assert.equal(L.rampStart({ hour: 6, minute: 30 }), "06:25");
});

test("an alarm just after midnight starts on the previous day", () => {
  const a = { hour: 0, minute: 2, days: L.Days.MON };
  const s = L.alarmSlots(a);
  assert.deepEqual(s.map((x) => x.hour), [23, 23, 23, 0, 0, 0]);
  assert.deepEqual(s.map((x) => x.minute), [57, 58, 59, 0, 1, 2]);
  assert.deepEqual(s.map((x) => x.days), [1, 1, 1, 2, 2, 2]);
  assert.equal(L.rampStart(a), "23:57");
  assert.deepEqual(L.readAlarm(s), { kind: "set", alarm: a });
});

test("day before wraps Sunday back to Saturday", () => {
  assert.equal(L.Days.dayBefore(L.Days.SUN), L.Days.SAT);
  assert.equal(L.Days.dayBefore(L.Days.ALL), L.Days.ALL);
  assert.equal(L.Days.dayBefore(L.Days.WEEKDAYS | L.Days.SUN), 0x1f | L.Days.SAT);
});

test("clearing writes the exact command that emptied the lamp", () => {
  const clear = L.setTimers([]);
  assert.equal(clear.length, 94);
  assert.equal(clear[0], 0x21);
  assert.equal(clear[93], 0x11);   // measured checksum
  assert.deepEqual(L.readAlarm(Array(6).fill(L.EMPTY)), { kind: "none" });
});

test("timers this app did not write are reported as foreign", () => {
  const s = [{ ...L.EMPTY, active: true, hour: 22, minute: 45, warm: 16 },
    { ...L.EMPTY, active: true, hour: 22, minute: 46, cool: 255 }, ...Array(4).fill(L.EMPTY)];
  assert.deepEqual(L.readAlarm(s), { kind: "foreign" });
});

test("white snapping on the lamp does not make our alarm look foreign", () => {
  const snapped = L.alarmSlots({ hour: 6, minute: 30, days: L.Days.WEEKDAYS }).map((x) => ({ ...x, warm: Math.max(0, x.warm - 1) }));
  assert.equal(L.readAlarm(snapped).kind, "set");
});

test("days read as a person says them", () => {
  assert.equal(L.Days.describe(L.Days.WEEKDAYS), "Mon–Fri");
  assert.equal(L.Days.describe(L.Days.ALL), "every day");
  assert.equal(L.Days.describe(0x02 | 0x08), "Mon Wed");
});
