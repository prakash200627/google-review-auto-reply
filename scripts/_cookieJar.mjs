/** Minimal cookie jar for smoke tests (no secrets logged). */
export class CookieJar {
  constructor() {
    this.map = new Map();
  }
  absorb(setCookieHeader) {
    const parts = String(setCookieHeader || "").split(/,(?=\s*[^;=]+=[^;=]+)/);
    for (const part of parts) {
      const pair = part.split(";")[0];
      const i = pair.indexOf("=");
      if (i <= 0) continue;
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (name) this.map.set(name, value);
    }
  }
  header() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}
