# Sunrise Lamp

A web page that sets a wake-up alarm on a Zengge / Magic Home Bluetooth bulb (`IOTW…`). The bulb's
**own timer** brightens it from dim warm white to full cool white over the 5 minutes before the
alarm, then it stays on - so it fires with the phone off.

Open it at **https://devriesgit.github.io/sunrise-lamp/?lamp=IOTWF1F3** (the QR on the lamp).

- **Chrome on Android only.** It uses Web Bluetooth; iPhones do not allow web pages to use Bluetooth.
- Tap **Connect to lamp**, pick the lamp in Chrome's list. The page sets the lamp's clock, shows
  whether it is on, and what alarm it holds.
- One alarm: a time and the days it repeats. *Turn alarm off* empties the lamp's timers.

Personal project. No server, no account, nothing leaves the phone except Bluetooth to the lamp.

## Files

| File | What |
| --- | --- |
| `lamp.js` | The protocol and the alarm - pure functions, every byte measured on the real lamp |
| `link.js` | Web Bluetooth: one operation at a time, clock set on connect, 700 ms settle before reading back |
| `app.js`, `index.html` | The screen |
| `test/lamp.test.mjs` | `node --test test/lamp.test.mjs` - 19 tests against bytes captured from the lamp |
