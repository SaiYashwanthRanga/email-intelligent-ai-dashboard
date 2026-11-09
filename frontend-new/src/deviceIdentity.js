// Persistent per-browser device identity for the Activity feature.
// Browsers don't expose a real device/computer name to a web page, so this
// is a random id generated once per browser + a best-effort "OS • Browser"
// label sniffed from the user agent. The same physical laptop shows up as a
// "different device" if the person switches browsers or clears site data.
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
  return `${detectOS(ua)} • ${detectBrowser(ua)} (${getDeviceId().slice(0, 4)})`;
}
