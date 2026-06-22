// ホスト正規化とハッシュ化。api/src/url.ts と完全に同一であること
// （ハッシュ一致が照合の前提）。照合単位はフルホスト名（サブドメインを保持）。

// 入力(URL文字列 or ホスト名)から正規化済みホストを返す。判定不能なら null。
export function normalizeHost(input) {
  let host = input.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
      host = new URL(host).hostname; // 完全な URL
    } else if (host.includes("/")) {
      host = new URL("http://" + host).hostname; // スキーム無しのパス付き
    }
  } catch {
    return null;
  }
  host = host.toLowerCase().replace(/\.+$/, ""); // 小文字化・末尾ドット除去
  if (host.startsWith("www.")) host = host.slice(4);
  return host || null;
}

export async function sha256Hex(s) {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
