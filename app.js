// The screen: connection status, On/Off, and the wake-up alarm. The browser twin of the Android
// app's LampViewModel.kt + MainActivity.kt.
import * as L from "./lamp.js";
import { LampLink, LampError } from "./link.js";

const $ = (id) => document.getElementById(id);

// ---- which lamp -----------------------------------------------------------------------------
// A web page cannot connect to a Bluetooth ADDRESS - Chrome makes the person pick from a list.
// So the QR carries the lamp's advertised NAME (?lamp=IOTWF1F3) and the list shows only that
// lamp. An old QR carrying the address (08:65:...) or no QR at all falls back to every IOTW bulb.
function lampNameFromUrl() {
  const raw = new URLSearchParams(location.search).get("lamp") || "";
  if (/^IOTW\w+$/i.test(raw)) {
    try { localStorage.setItem("lampName", raw.toUpperCase()); } catch { /* private mode */ }
    return raw.toUpperCase();
  }
  try { return localStorage.getItem("lampName"); } catch { return null; }
}
const lampName = lampNameFromUrl();

// ---- state ----------------------------------------------------------------------------------
const state = {
  link: "idle",          // idle | connecting | connected | failed
  reason: "",
  lamp: null,            // {on, warm, cool}
  busy: false,           // a switch command is in flight
  reading: null,         // what the lamp's timers hold: {kind: none|set|foreign, alarm?}
  draft: { hour: 6, minute: 0, days: L.Days.WEEKDAYS },   // first-time default - an assumption
  draftTouched: false,
  alarmBusy: false,
  alarmMsg: null, alarmErr: false,
  radioOff: false,       // the phone's Bluetooth is switched off (where Chrome can tell)
};
let device = null;       // kept for the session so Reconnect does not need the chooser again
let conn = null;

// ---- actions --------------------------------------------------------------------------------

const isOurLamp = (d) => (lampName ? d.name === lampName : (d.name || "").startsWith(L.NAME_PREFIX));

/**
 * Connect WITHOUT a tap, if Chrome already lets this page use the lamp (it was picked on an
 * earlier visit). Needs navigator.bluetooth.getDevices(), which not every Chrome has - where it
 * is missing this does nothing and the person taps Connect once. Never shows the chooser.
 */
async function autoConnect() {
  if (device || state.link === "connecting" || state.link === "connected") {
    if (device && state.link !== "connecting" && state.link !== "connected") await connect();
    return;
  }
  if (!navigator.bluetooth.getDevices) return;
  try {
    const known = (await navigator.bluetooth.getDevices()).find(isOurLamp);
    if (known) { device = known; await connect(); }
  } catch { /* not allowed here - the Connect button still works */ }
}

async function connect() {
  if (state.link === "connecting" || state.link === "connected") return;
  try {
    if (!device) {
      // Must run straight from a tap - Chrome only opens its chooser on a user gesture.
      device = await navigator.bluetooth.requestDevice({
        filters: [lampName ? { name: lampName } : { namePrefix: L.NAME_PREFIX }],
        optionalServices: [L.SERVICE],   // the lamp does not advertise it, so it must be named
      });
    }
  } catch (e) {
    // NotFoundError = the person closed the chooser, or no lamp was in range.
    set({ link: "failed", reason: e.name === "NotFoundError"
      ? "No lamp chosen. Is the lamp plugged in and within a few metres? Tap Connect to try again."
      : "Bluetooth is off or not allowed. Switch it on and tap Connect." });
    return;
  }
  set({ link: "connecting", reason: "" });
  const c = new LampLink(device);
  try {
    await c.connect();
    c.onDisconnected = () => dropped("The lamp dropped the connection. Tap Reconnect.");
    const lamp = await c.readState();
    const reading = L.readAlarm(await c.readTimers());
    conn = c;
    showReading(reading);
    set({ link: "connected", lamp });
  } catch (e) {
    c.close();
    set({ link: "failed", reason: e instanceof LampError ? e.message : "Could not connect. Tap Reconnect." });
  }
}

async function setPower(on) {
  if (!conn || state.busy) return;
  set({ busy: true });
  try {
    set({ lamp: await conn.setPower(on) });
  } catch (e) {
    dropped(e instanceof LampError ? e.message : "Lost the lamp.");
  } finally {
    set({ busy: false });
  }
}

function showReading(r) {
  state.reading = r;
  if (r.kind === "set" && !state.draftTouched) state.draft = { ...r.alarm };
}

async function runAlarm(work) {
  set({ alarmBusy: true, alarmMsg: null });
  try {
    set({ alarmMsg: await work(), alarmErr: false });
  } catch (e) {
    set({ alarmMsg: e instanceof LampError ? e.message : "Something went wrong. Tap again.", alarmErr: true });
  } finally {
    set({ alarmBusy: false });
  }
}

function saveAlarm() {
  const alarm = { ...state.draft };
  if (!conn || !alarm.days || state.alarmBusy) return;
  runAlarm(async () => {
    const wanted = L.alarmSlots(alarm);
    const stored = await conn.writeTimers(wanted);
    showReading(L.readAlarm(stored));
    if (!L.sameSchedule(stored, wanted)) throw new LampError("The lamp did not store the alarm correctly. Tap Save again.");
    state.draftTouched = false;
    const days = L.Days.describe(alarm.days);
    return `Saved. ${days[0].toUpperCase() + days.slice(1)}: the lamp starts brightening at ` +
      `${L.rampStart(alarm)} and is fully on at ${L.alarmTime(alarm)}.`;
  });
}

function clearAlarm() {
  if (!conn || state.alarmBusy) return;
  runAlarm(async () => {
    const stored = await conn.writeTimers([]);
    showReading(L.readAlarm(stored));
    if (stored.some((s) => s.active)) throw new LampError("The lamp still holds timers. Tap Turn alarm off again.");
    return "Alarm off. The lamp will not switch itself on.";
  });
}

function disconnect() {
  if (!$("lightView").hidden) showLightView(false);
  conn?.close();
  conn = null;
  if (state.link === "connected" || state.link === "connecting") set({ link: "idle" });
}

function dropped(reason) {
  if (!$("lightView").hidden) showLightView(false);
  conn?.close();
  conn = null;
  set({ link: "failed", reason });
}

// ---- rendering ------------------------------------------------------------------------------

function set(changes) { Object.assign(state, changes); render(); }

// The white the lamp gives for a warm/cool mix (~2700 K to ~6500 K) - the colour card's swatch.
const WARM_RGB = [255, 170, 90], COOL_RGB = [214, 228, 255];
function lightColour(warm, cool) {
  const t = warm + cool ? cool / (warm + cool) : 0;
  const c = WARM_RGB.map((w, i) => Math.round(w + (COOL_RGB[i] - w) * t));
  return `rgb(${c.join(",")})`;
}

function render() {
  const s = state;
  const connected = s.link === "connected";
  const connecting = s.link === "connecting";

  // Top bar: where the connection stands, in words.
  $("status").className = "status" + (connected ? " on" : s.link === "failed" ? " bad" : "");
  $("statusText").textContent = connected ? "Connected" : connecting ? "Connecting…" : "Not connected";

  // Connect card - only while not connected. A first visit sees the three steps; a return visit
  // (the lamp already picked this session) just sees Reconnect.
  $("connectCard").hidden = connected;
  $("connectTitle").textContent = connecting ? "Connecting to your lamp…"
    : s.link === "failed" ? "Couldn't reach the lamp" : "Connect to your lamp";
  $("steps").hidden = $("onceNote").hidden = !!device;
  $("stepName").textContent = lampName ? `"${lampName}"` : "the lamp";
  const notice = s.link === "failed" ? s.reason
    : s.radioOff ? "Bluetooth is off. Switch it on in the phone's quick settings." : "";
  $("notice").hidden = !notice;
  $("notice").textContent = notice;
  $("notice").className = "notice" + (s.link === "failed" ? " bad" : "");
  $("connectBtn").disabled = connecting;
  $("connectBtn").textContent = connecting ? "Connecting…" : device ? "Reconnect" : "Connect";

  // Lamp card - its state, and the switch. Greyed with the reason while not connected.
  const on = connected && s.lamp ? s.lamp.on : null;
  $("stateText").textContent = on === null ? "" : on ? "On" : "Off";
  $("stateText").hidden = on === null;   // no big dash: at that size a dash reads as "loading"
  $("stateDetail").textContent = !connected ? "Connect to see the lamp and switch it." : s.busy ? "Switching…" : "";
  $("stateDetail").hidden = connected && !s.busy;
  $("onBtn").disabled = $("offBtn").disabled = !connected || s.busy;
  $("onBtn").setAttribute("aria-pressed", String(on === true));
  $("offBtn").setAttribute("aria-pressed", String(on === false));

  // Alarm card - one line for what the LAMP holds (read from it, never a default), then the editor.
  const r = s.reading;
  $("panel").className = connected ? "on" : "off";
  renderLightCard(connected);
  $("editBody").hidden = !connected;
  if (!connected) { $("storedNote").textContent = "Connect to see and set the lamp's wake-up alarm."; return; }

  $("storedNote").textContent = !r ? "Reading the lamp…"
    : r.kind === "none" ? "No alarm on the lamp yet."
    : r.kind === "set" ? `On the lamp: ${L.alarmTime(r.alarm)}, ${L.Days.describe(r.alarm.days)}. ` +
      `It starts brightening at ${L.rampStart(r.alarm)}.`
    : "The lamp holds timers from another app. Saving an alarm replaces them.";

  const d = s.draft;
  if (document.activeElement !== $("time")) $("time").value = L.alarmTime(d);
  for (const chip of $("days").children) chip.setAttribute("aria-pressed", String(!!(d.days & Number(chip.dataset.bit))));
  const unsaved = r?.kind !== "set" || r.alarm.hour !== d.hour || r.alarm.minute !== d.minute || r.alarm.days !== d.days;
  const blocker = s.alarmBusy ? null : !d.days ? "Pick at least one day." : null;
  $("saveBtn").textContent = s.alarmBusy ? "Saving…" : unsaved ? "Save alarm" : "Saved on the lamp";
  $("saveBtn").disabled = s.alarmBusy || !!blocker || !unsaved;
  $("saveHint").hidden = !blocker;
  $("saveHint").textContent = blocker ?? "";
  $("clearBtn").hidden = !(r?.kind === "set" || r?.kind === "foreign");
  $("clearBtn").disabled = s.alarmBusy;
  $("alarmMsg").textContent = s.alarmMsg ?? "";
  $("alarmMsg").className = "msg" + (s.alarmErr ? " err" : "");
}

// ---- colour & brightness -------------------------------------------------------------------
// One screen: White (warmth) or Colour (a wheel), and one brightness slider for both. The marker and
// the % move while a finger drags, but the lamp is only told when the finger LIFTS - live updates made
// it flash (his feedback, 25 Oct 2026). Only the latest value is ever queued.

const light = { mode: "white", hue: 30, sat: 1, level: 1, cool: 0 };   // what the panel shows
let pendingLight = null, sendingLight = false;
let lampMode = null;   // "white" or "colour": what the lamp is showing, so a change sends ONE command
// Near the wheel's centre the colour is white. White made from the red, green and blue LEDs is far
// dimmer than the lamp's own white LEDs (his report: "the same cool white is just dimmer"), so the
// centre zone uses the white LEDs, at the warmth last set under White.
const WHEEL_WHITE_ZONE = 0.12;

/** Fill the panel from what the lamp reported. */
function lightFromLamp(l) {
  if (!l) return;
  lampMode = l.red || l.green || l.blue ? "colour" : "white";
  if (l.red || l.green || l.blue) {
    const { h, s, v } = L.rgbToHsv(l.red, l.green, l.blue);
    Object.assign(light, { mode: "colour", hue: h, sat: s, level: Math.max(0.01, v) });
  } else if (l.warm !== null && l.warm !== undefined) {
    const total = l.warm + l.cool;
    Object.assign(light, { mode: "white", level: Math.max(0.01, Math.min(1, total / 255)), cool: total ? l.cool / total : 0 });
  }
}

/** White or colour, as the lamp will show it (the wheel's centre zone counts as white). */
const sendsWhite = () => light.mode === "white" || light.sat < WHEEL_WHITE_ZONE;

/**
 * The commands for the current setting: switch on first if the lamp is off, zero the other set of
 * LEDs only when changing between white and colour (zeroing every time made a visible flash), then
 * the one command that sets the light.
 */
function lightCommands() {
  const cmds = state.lamp && !state.lamp.on ? [L.power(true)] : [];
  const white = sendsWhite();
  const pair = white ? L.whiteCommands(...L.whiteAt(light.level, light.cool))
    : L.colourCommands(...L.atBrightness(L.hueToRgb(light.hue, light.sat), light.level));
  const switching = lampMode !== (white ? "white" : "colour");
  lampMode = white ? "white" : "colour";
  return [...cmds, ...(switching ? pair : pair.slice(1))];
}

function sendLight() {
  if (!conn) return;
  pendingLight = lightCommands();
  // What the lamp will now show - kept locally so the card and the On/Off switch agree.
  const white = sendsWhite();
  const rgb = white ? [0, 0, 0] : L.atBrightness(L.hueToRgb(light.hue, light.sat), light.level);
  const [warm, cool] = white ? L.whiteAt(light.level, light.cool) : [0, 0];
  state.lamp = { ...(state.lamp || {}), on: true, mode: 0x61, red: rgb[0], green: rgb[1], blue: rgb[2], warm, cool };
  if (!sendingLight) pumpLight();
}

async function pumpLight() {
  sendingLight = true;
  try {
    while (pendingLight && conn) {
      const cmds = pendingLight; pendingLight = null;
      await conn.sendCommands(cmds);
    }
  } catch (e) {
    dropped(e instanceof LampError ? e.message : "Lost the lamp.");
  } finally {
    sendingLight = false;
    render();
  }
}

/** The card at the bottom: a swatch and a few words for what the lamp shows now. */
function renderLightCard(connected) {
  const l = connected ? state.lamp : null;
  $("lightBtn").disabled = !connected;
  if (!l) {
    $("swatch").style.background = "";
    $("lightNow").textContent = "Connect to change the lamp's colour.";
    return;
  }
  if (!l.on) { $("swatch").style.background = ""; $("lightNow").textContent = "The lamp is off."; return; }
  if (l.red || l.green || l.blue) {
    const { v } = L.rgbToHsv(l.red, l.green, l.blue);
    const full = L.atBrightness([l.red, l.green, l.blue], 1 / Math.max(v, 0.01)).map((c) => Math.min(255, c));
    $("swatch").style.background = `rgb(${full.join(",")})`;
    $("lightNow").textContent = `Colour, ${Math.round(v * 100)} % bright`;
  } else {
    const total = (l.warm ?? 0) + (l.cool ?? 0);
    const share = total ? l.cool / total : 0;
    $("swatch").style.background = lightColour(1 - share, share);
    const kind = share < 0.2 ? "Warm white" : share > 0.8 ? "Cool white" : "Neutral white";
    $("lightNow").textContent = `${kind}, ${Math.round(Math.min(1, total / 255) * 100)} % bright`;
  }
}

// The wheel: hue around the circle, saturation from the centre (white) to the edge (full colour).
function drawWheel() {
  const c = $("wheel"), ctx = c.getContext("2d"), n = c.width, r = n / 2;
  const img = ctx.createImageData(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const dx = x - r, dy = y - r, d = Math.hypot(dx, dy);
    if (d > r) continue;
    const [R, G, B] = L.hueToRgb((Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360, d / r);
    const i = (y * n + x) * 4;
    img.data[i] = R; img.data[i + 1] = G; img.data[i + 2] = B; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

function renderSheet() {
  const colour = light.mode === "colour";
  $("modeWhite").setAttribute("aria-pressed", String(!colour));
  $("modeColour").setAttribute("aria-pressed", String(colour));
  $("wheelBox").hidden = !colour;
  $("warmthBox").hidden = colour;
  $("warmth").value = Math.round(light.cool * 100);
  $("bright").value = Math.round(light.level * 100);
  $("brightVal").textContent = `${Math.round(light.level * 100)} %`;
  const a = light.hue * Math.PI / 180, rad = light.sat * 130;   // 130 px = half the wheel
  $("wheelMark").style.left = `${130 + rad * Math.cos(a)}px`;
  $("wheelMark").style.top = `${130 + rad * Math.sin(a)}px`;
  $("wheelMark").style.background = `rgb(${L.hueToRgb(light.hue, light.sat).join(",")})`;
}

function setupLightSheet() {
  drawWheel();
  $("lightBtn").onclick = () => { lightFromLamp(state.lamp); renderSheet(); showLightView(true); };
  $("sheetDone").onclick = () => showLightView(false);
  // White is one tap, so it goes to the lamp at once. Colour only shows the wheel: nothing is sent
  // until a colour is picked (sending at once was a second source of the "dimmer" white).
  $("modeWhite").onclick = () => { light.mode = "white"; renderSheet(); sendLight(); };
  $("modeColour").onclick = () => { light.mode = "colour"; renderSheet(); };
  // Sliders: "input" moves the readout while dragging; "change" fires on release and sends.
  $("warmth").oninput = (e) => { light.cool = Number(e.target.value) / 100; renderSheet(); };
  $("bright").oninput = (e) => { light.level = Number(e.target.value) / 100; renderSheet(); };
  $("warmth").onchange = () => sendLight();
  $("bright").onchange = () => sendLight();
  const pick = (e) => {
    const box = $("wheel").getBoundingClientRect();
    const dx = e.clientX - box.left - box.width / 2, dy = e.clientY - box.top - box.height / 2;
    light.hue = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
    light.sat = Math.min(1, Math.hypot(dx, dy) / (box.width / 2));
    if (light.sat < WHEEL_WHITE_ZONE) light.sat = 0;   // snap to the centre: the white LEDs
    renderSheet();
  };
  const wheel = $("wheel");
  wheel.addEventListener("pointerdown", (e) => { wheel.setPointerCapture(e.pointerId); pick(e); });
  wheel.addEventListener("pointermove", (e) => { if (wheel.hasPointerCapture(e.pointerId)) pick(e); });
  wheel.addEventListener("pointerup", (e) => { pick(e); sendLight(); });   // the finger lifted: send
}

/** Swap the page for the colour screen and back. */
function showLightView(open) {
  $("panel").hidden = open;
  $("lightView").hidden = !open;
  window.scrollTo(0, 0);
  if (open) $("sheetHead").focus(); else { render(); $("lightBtn").focus(); }
}

// ---- start ----------------------------------------------------------------------------------

function start() {
  if (!navigator.bluetooth) { $("unsupported").hidden = false; return; }
  $("panel").hidden = false;

  // Day chips, Monday first; each is a 48 px toggle button with its state in aria-pressed.
  for (const [bit, name] of L.Days.MONDAY_FIRST) {
    const b = document.createElement("button");
    b.className = "day"; b.dataset.bit = bit; b.textContent = name.slice(0, 2);
    b.setAttribute("aria-label", name);
    b.onclick = () => { state.draft.days ^= bit; state.draftTouched = true; set({ alarmMsg: null }); };
    $("days").appendChild(b);
  }
  // "input" as well as "change", so the sunrise preview follows the picker as it turns.
  const onTime = (e) => {
    if (!e.target.value) return;
    const [h, m] = e.target.value.split(":").map(Number);
    state.draft.hour = h; state.draft.minute = m; state.draftTouched = true;
    set({ alarmMsg: null });
  };
  $("time").addEventListener("input", onTime);
  $("time").addEventListener("change", onTime);
  $("connectBtn").onclick = connect;
  $("onBtn").onclick = () => setPower(true);
  $("offBtn").onclick = () => setPower(false);
  $("saveBtn").onclick = saveAlarm;
  $("clearBtn").onclick = clearAlarm;
  setupLightSheet();

  // Never hold the lamp while the page is in the background - it may take only one connection -
  // and pick it straight back up when the person returns, so they never scan again.
  document.addEventListener("visibilitychange", () => { if (document.hidden) disconnect(); else autoConnect(); });

  // Warn about Bluetooth being off BEFORE they try, instead of after a failed chooser.
  navigator.bluetooth.getAvailability?.().then((on) => set({ radioOff: !on })).catch(() => {});
  navigator.bluetooth.addEventListener?.("availabilitychanged", (e) => set({ radioOff: !e.value }));

  // ?preview=connected (or =colour, with the colour panel open) - draws the connected screen with a sample lamp (on, 06:30 weekdays) so the
  // layout can be checked without a lamp. Touches no Bluetooth; nothing can be saved from it.
  const preview = new URLSearchParams(location.search).get("preview");
  if (preview === "connected" || preview === "colour") {
    const alarm = { hour: 6, minute: 30, days: L.Days.WEEKDAYS };
    state.draft = { ...alarm };
    Object.assign(state, { link: "connected", lamp: { on: true, mode: 0x61, red: 0, green: 0, blue: 0, warm: 0, cool: 255 }, reading: { kind: "set", alarm } });
    render();
    if (preview === "colour") {   // the colour panel open on an amber
      Object.assign(light, { mode: "colour", hue: 38, sat: 0.85, level: 0.8 });
      renderSheet(); showLightView(true);
    }
    return;
  }

  render();
  autoConnect();
}

start();
