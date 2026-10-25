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
};
let device = null;       // kept for the session so Reconnect does not need the chooser again
let conn = null;

// ---- actions --------------------------------------------------------------------------------

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
      ? "No lamp chosen. Is the lamp powered and within a few metres? Tap Connect to try again."
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
  conn?.close();
  conn = null;
  if (state.link === "connected" || state.link === "connecting") set({ link: "idle" });
}

function dropped(reason) {
  conn?.close();
  conn = null;
  set({ link: "failed", reason });
}

// ---- rendering ------------------------------------------------------------------------------

function set(changes) { Object.assign(state, changes); render(); }

function render() {
  const connected = state.link === "connected";
  const s = state;

  // Status card
  let dot = "", headline = "Not connected", detail = "";
  if (connected) {
    dot = s.lamp?.on ? "on" : "";
    headline = s.lamp?.on ? "Lamp is ON" : "Lamp is OFF";
    detail = s.lamp?.on && s.lamp.warm !== null ? `warm ${s.lamp.warm} · cool ${s.lamp.cool}` : "Connected";
  } else if (s.link === "connecting") {
    headline = "Connecting…"; detail = "Talking to the lamp over Bluetooth";
  } else if (s.link === "failed") {
    dot = "bad"; detail = s.reason;
  } else {
    detail = "Tap Connect to reach the lamp.";
  }
  $("dot").className = "dot " + dot;
  $("headline").textContent = headline;
  $("detail").textContent = detail;

  // Connect / Reconnect - only while not connected.
  $("connectBtn").hidden = connected || s.link === "connecting";
  $("connectBtn").textContent = device ? "Reconnect" : "Connect to lamp";
  $("connectHint").hidden = connected || s.link === "connecting" || !!device;

  // On / Off - always on screen; greyed with the reason when unusable.
  const usable = connected && !s.busy;
  $("onBtn").disabled = $("offBtn").disabled = !usable;
  $("powerHint").textContent = usable ? "" : s.busy ? "Waiting for the lamp…"
    : s.link === "connecting" ? "The buttons work once the lamp is connected." : "Not connected - tap Connect.";

  // Alarm - what the LAMP holds, read from it, not remembered by the phone.
  const r = s.reading;
  $("stored").textContent = !r ? (connected ? "Reading the lamp…" : "Connect to see the lamp's alarm.")
    : r.kind === "none" ? "No alarm set on the lamp."
    : r.kind === "set" ? `On the lamp: ${L.alarmTime(r.alarm)}, ${L.Days.describe(r.alarm.days)}.`
    : "The lamp holds timers from another app. Saving an alarm replaces them.";
  $("stored").className = "muted" + (r?.kind === "foreign" ? " warn" : "");

  const d = s.draft;
  if (document.activeElement !== $("time")) $("time").value = L.alarmTime(d);
  $("rampText").textContent = `Brightens from ${L.rampStart(d)}, fully on at ${L.alarmTime(d)}, then stays on.`;
  for (const chip of $("days").children) chip.classList.toggle("on", !!(d.days & Number(chip.dataset.bit)));

  const unsaved = r?.kind !== "set" || r.alarm.hour !== d.hour || r.alarm.minute !== d.minute || r.alarm.days !== d.days;
  const blocker = !connected ? "Connect to the lamp to save." : s.alarmBusy ? "Talking to the lamp…"
    : !d.days ? "Tick at least one day." : null;
  $("saveBtn").textContent = unsaved ? "Save alarm" : "Saved";
  $("saveBtn").disabled = !!blocker || !unsaved;
  $("saveHint").textContent = blocker ?? "";
  $("clearBtn").hidden = !(r?.kind === "set" || r?.kind === "foreign");
  $("clearBtn").disabled = !connected || s.alarmBusy;
  $("alarmMsg").textContent = s.alarmMsg ?? "";
  $("alarmMsg").className = s.alarmErr ? "err" : "";
}

// ---- start ----------------------------------------------------------------------------------

function start() {
  if (lampName) $("lampName").textContent = `Lamp ${lampName}`;
  if (!navigator.bluetooth) { $("unsupported").hidden = false; return; }
  $("panel").hidden = false;

  // Day chips, Monday first; each is a 48 px tap target.
  for (const [bit, name] of L.Days.MONDAY_FIRST) {
    const b = document.createElement("button");
    b.className = "day"; b.dataset.bit = bit; b.textContent = name.slice(0, 2);
    b.onclick = () => { state.draft.days ^= bit; state.draftTouched = true; set({ alarmMsg: null }); };
    $("days").appendChild(b);
  }
  $("time").addEventListener("change", (e) => {
    const [h, m] = (e.target.value || "06:00").split(":").map(Number);
    state.draft.hour = h; state.draft.minute = m; state.draftTouched = true;
    set({ alarmMsg: null });
  });
  $("connectBtn").onclick = connect;
  $("onBtn").onclick = () => setPower(true);
  $("offBtn").onclick = () => setPower(false);
  $("saveBtn").onclick = saveAlarm;
  $("clearBtn").onclick = clearAlarm;

  // Never hold the lamp while the page is in the background - it may take only one connection.
  document.addEventListener("visibilitychange", () => { if (document.hidden) disconnect(); });
  render();
}

start();
