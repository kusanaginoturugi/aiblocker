// URL 正規化とハッシュ化。報告側と照合側で完全に同一であること。
// 拡張機能側にも同じロジックを移植する（ハッシュ一致が照合の前提）。

export interface Normalized {
  domain: string; // 例: "example.com"
  url: string; // 例: "example.com/path/to/article"
}

export function normalize(input: string): Normalized {
  const u = new URL(input);

  // ホスト: 小文字化 + 先頭 www. 除去
  let host = u.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);

  // パス: 末尾スラッシュ除去（ルートは空文字に）。大文字小文字は保持。
  let path = u.pathname;
  if (path.endsWith("/")) path = path.slice(0, -1);

  // スキーム・クエリ・フラグメントは捨てる。
  const domain = host;
  const url = path ? `${host}${path}` : host;
  return { domain, url };
}

export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
