// 現ページの登録ホストがリスト入りなら blur。さらにページ内リンクのうち、
// リンク先ホストがリスト入りのものにバッジ(絵文字)を付ける。
// このスクリプト自体はネットワーク通信をしない（判定は background の Bloom で完結）。

const BADGE = "🤖"; // 変えたければここ。候補: ⚠️ 🫥 🚫 ✨

(async () => {
  // ページ内リンクをホストごとにまとめる
  const linkHosts = new Map(); // host -> [a要素]
  for (const a of document.querySelectorAll("a[href]")) {
    let host;
    try { host = new URL(a.href, location.href).hostname; } catch { continue; }
    if (!host) continue;
    if (!linkHosts.has(host)) linkHosts.set(host, []);
    linkHosts.get(host).push(a);
  }

  // 現ページ + 全リンクホストを 1 回で問い合わせ
  const hosts = [...new Set([location.hostname, ...linkHosts.keys()])];
  const results = await checkMany(hosts);
  if (!results) return;

  if (results[location.hostname]) applyBlur();

  for (const [host, els] of linkHosts) {
    if (!results[host]) continue;
    for (const a of els) addBadge(a);
  }
})();

function checkMany(hosts) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "checkMany", hosts }, (r) => {
      if (chrome.runtime.lastError) return resolve(null); // SW 起動前等
      resolve(r?.results || null);
    });
  });
}

function addBadge(a) {
  if (a.dataset.aiblocker) return; // 二重付与防止
  a.dataset.aiblocker = "1";
  const badge = document.createElement("span");
  badge.className = "aiblocker-badge";
  badge.textContent = " " + BADGE;
  badge.title = "AI 生成コンテンツとして報告されているサイト";
  badge.style.cssText = "font-size:0.9em;opacity:0.85;cursor:help;";
  a.appendChild(badge);
}

function applyBlur() {
  const style = document.createElement("style");
  style.id = "aiblocker-style";
  style.textContent = `
    html.aiblocker-blur body { filter: blur(4px); transition: filter .15s ease; }
    html.aiblocker-blur body:hover { filter: none; }
  `;
  (document.head || document.documentElement).appendChild(style);
  document.documentElement.classList.add("aiblocker-blur");
}
