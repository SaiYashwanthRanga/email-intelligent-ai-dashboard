// Best-effort device identity for the activity-tracking view.
//
// IMPORTANT LIMITATION: browsers do not expose the real OS-level device or
// computer name to a web page (no such API exists — it's withheld for
// privacy, by every major browser). So "device" here is NOT "Sai's Laptop" —
// it's a persistent id generated on first load and stored in this browser's
// localStorage, paired with an OS + browser label parsed from the user
// agent string. That means:
//   - The same physical laptop shows up as a "different device" if the
//     person switches browsers, uses a private/incognito window, or clears
//     site data.
//   - Two different laptops with the same OS + browser look identical
//     except for the short id suffix on the label.
// This is the same approach every web analytics tool uses for "device"
// tracking — there is no stronger signal available from inside a browser tab.

const DEVICE_ID_KEY = 'emailDashboardDeviceId';

export function getDeviceId() {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // localStorage unavailable (private mode edge cases) — fall back to a
    // per-load id rather than throwing; this device just won't persist.
    return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function detectOS(ua) {
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Mac OS X/i.test(ua)) return 'macOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Unknown OS';
}

function detectBrowser(ua) {
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return 'Chrome';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Safari\//i.test(ua) && !/Chrome/i.test(ua)) return 'Safari';
  return 'Unknown Browser';
}

export function getDeviceLabel() {
  const ua = navigator.userAgent || '';
  const os = detectOS(ua);
  const browser = detectBrowser(ua);
  const idSuffix = getDeviceId().slice(0, 4);
  return `${os} • ${browser} (${idSuffix})`;
}
