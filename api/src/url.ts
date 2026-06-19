// ホスト正規化とハッシュ化。報告側と照合側で完全に同一であること。
// 拡張機能側にも同じロジック（tldts + sha256Hex）を移植する（ハッシュ一致が照合の前提）。
//
// プライバシー方針: 報告・照合の単位は「登録ドメイン(eTLD+1)」のみ。
// サブドメイン・パス・クエリ・フラグメントは一切使わない＝閲覧ページ単位の情報は外に出ない。
// 例: https://blog.example.co.jp/a/b?x=1#f → "example.co.jp"
//     https://foo.github.io/page        → "foo.github.io" (github.io は public suffix)

import { getDomain } from "tldts";

// 入力(URL文字列 or ホスト名)から登録ドメインを返す。
// 判定不能(IP・localhost・不正)なら null。
export function registrableDomain(input: string): string | null {
  return getDomain(input); // tldts が小文字化・サブドメイン除去・PSL準拠で返す
}

export async function sha256Hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(digest);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
