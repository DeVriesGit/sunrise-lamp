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

// The white the lamp actually gives at a step: warm white ~2700 K, cool white ~6500 K, mixed by
// the step's cool share. Drawn at full brightness - the bar's HEIGHT carries the brightness.
const WARM_RGB = [255, 170, 90], COOL_RGB = [214, 228, 255];
function lightColour(warm, cool) {
  const t = warm + cool ? cool / (warm + cool) : 0;
  const c = WARM_RGB.map((w, i) => Math.round(w + (COOL_RGB[i] - w) * t));
  return `rgb(${c.join(",")})`;
}

function renderRamp(alarm, unsaved) {
  const slots = L.alarmSlots(alarm);
  $("ramp").replaceChildren(...slots.map((s) => {
    const bar = document.createElement("div");
    bar.style.height = `${Math.max(3, Math.round(((s.warm + s.cool) / 255) * 100))}%`;
    bar.style.background = lightColour(s.warm, s.cool);
    return bar;
  }));
  $("rampAxis").replaceChildren(...slots.map((s) => {
    const t = document.createElement("span");
    t.textContent = L.clock(s.hour * 60 + s.minute);
    return t;
  }));
  $("rampText").textContent = (unsaved ? "Not saved yet. " : "") +
    `From ${L.rampStart(alarm)} the lamp glows dim and warm, then brightens each minute ` +
    `to full cool white at ${L.alarmTime(alarm)} - and stays on.`;
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

  // Alarm card - the answer first (what the LAMP holds), then the editor with its sunrise preview.
  const r = s.reading;
  $("panel").className = connected ? "on" : "off";
  $("alarmEmpty").hidden = connected;
  $("alarmBody").hidden = !connected;
  $("editCard").hidden = !connected;
  if (!connected) return;

  $("storedTime").textContent = r?.kind === "set" ? L.alarmTime(r.alarm) : r?.kind === "none" ? "Off" : "—";
  $("storedTime").className = "time num" + (r?.kind === "set" ? "" : " none");
  $("storedDays").textContent = r?.kind === "set" ? L.Days.describe(r.alarm.days) : "";
  $("storedNote").textContent = !r ? "Reading the lamp…"
    : r.kind === "none" ? "No alarm on the lamp yet. Set one below."
    : r.kind === "set" ? `The lamp starts brightening at ${L.rampStart(r.alarm)}.`
    : "The lamp holds timers from another app. Saving an alarm replaces them.";

  const d = s.draft;
  if (document.activeElement !== $("time")) $("time").value = L.alarmTime(d);
  for (const chip of $("days").children) chip.setAttribute("aria-pressed", String(!!(d.days & Number(chip.dataset.bit))));
  const unsaved = r?.kind !== "set" || r.alarm.hour !== d.hour || r.alarm.minute !== d.minute || r.alarm.days !== d.days;
  renderRamp(d, unsaved);   // the lamp's sunrise; while editing, a preview of the one about to be saved
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

// ---- start ----------------------------------------------------------------------------------

function start() {
  if (lampName) $("lampName").textContent = lampName;
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

  // Never hold the lamp while the page is in the background - it may take only one connection -
  // and pick it straight back up when the person returns, so they never scan again.
  document.addEventListener("visibilitychange", () => { if (document.hidden) disconnect(); else autoConnect(); });

  // Warn about Bluetooth being off BEFORE they try, instead of after a failed chooser.
  navigator.bluetooth.getAvailability?.().then((on) => set({ radioOff: !on })).catch(() => {});
  navigator.bluetooth.addEventListener?.("availabilitychanged", (e) => set({ radioOff: !e.value }));

  // ?preview=connected - draws the connected screen with a sample lamp (on, 06:30 weekdays) so the
  // layout can be checked without a lamp. Touches no Bluetooth; nothing can be saved from it.
  if (new URLSearchParams(location.search).get("preview") === "connected") {
    const alarm = { hour: 6, minute: 30, days: L.Days.WEEKDAYS };
    state.draft = { ...alarm };
    Object.assign(state, { link: "connected", lamp: { on: true, warm: 0, cool: 255 }, reading: { kind: "set", alarm } });
    render();
    return;
  }

  render();
  autoConnect();
}

start();
