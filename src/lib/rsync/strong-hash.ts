// SHA-256 strong hash via Web Crypto. Works in browser, Node 20+, and Workers.

export async function sha256(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const buf = await crypto.subtle.digest("SHA-256", view);
  return bufToHex(new Uint8Array(buf));
}

function bufToHex(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += buf[i].toString(16).padStart(2, "0");
  }
  return out;
}
