// 現ページの登録ホストがリスト入りなら blur。さらにページ内リンクのうち、
// リンク先ホストがリスト入りのものにバッジ(絵文字)を付ける。
// SPA の再描画で消えないよう、MutationObserver で追加リンクにも付け直す。
// このスクリプト自体はネットワーク通信をしない（判定は background の Bloom で完結）。

const BADGE = "🤖"; // 変えたければここ。候補: ⚠️ 🫥 🚫 ✨

(async () => {
  // 現ページ
  const pageRes = await checkMany([location.hostname]);
  if (pageRes && pageRes[location.hostname]) applyBlur();

  // 既存リンク
  await processLinks([...document.querySelectorAll("a[href]")]);

  // 以後に追加・再描画されるリンクを監視（SPA 対応）
  observeLinks();
})();

function checkMany(hosts) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "checkMany", hosts }, (r) => {
      if (chrome.runtime.lastError) return resolve(null); // SW 起動前等
      resolve(r?.results || null);
    });
  });
}

async function processLinks(links) {
  const linkHosts = new Map(); // host -> [a要素]
  for (const a of links) {
    if (a.dataset.aiblocker) continue; // 付与済みは skip
    let host;
    try { host = new URL(a.href, location.href).hostname; } catch { continue; }
    if (!host) continue;
    if (!linkHosts.has(host)) linkHosts.set(host, []);
    linkHosts.get(host).push(a);
  }
  if (linkHosts.size === 0) return;
  const results = await checkMany([...linkHosts.keys()]);
  if (!results) return;
  for (const [host, els] of linkHosts) {
    if (!results[host]) continue;
    for (const a of els) addBadge(a);
  }
}

function observeLinks() {
  const obs = new MutationObserver((muts) => {
    const found = [];
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType !== 1) continue; // 要素のみ
        if (n.matches?.("a[href]")) found.push(n);
        const inner = n.querySelectorAll?.("a[href]");
        if (inner) for (const x of inner) found.push(x);
      }
    }
    if (found.length) processLinks(found);
  });
  obs.observe(document.documentElement, { childList: true, subtree: true });
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
