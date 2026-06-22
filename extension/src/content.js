// 現ページの登録ホストがリスト入りなら blur。さらにページ内リンクのうち、
// リンク先ホストがリスト入りのものにバッジ(絵文字)を付ける。
// SPA の再描画で消えないよう、MutationObserver で追加リンクにも付け直す。
// このスクリプト自体はネットワーク通信をしない（判定は background の Bloom で完結）。

const BADGE = "🤖"; // 変えたければここ。候補: ⚠️ 🫥 🚫 ✨

(async () => {
  // 現ページ（SW の cold start で最初の応答が null になることがあるのでリトライ）
  if (await checkPageWithRetry(location.hostname)) {
    applyBlur();
    addReportButton();
  }

  // 既存リンク
  await processLinks([...document.querySelectorAll("a[href]")]);

  // 以後に追加・再描画されるリンクを監視（SPA 対応）
  observeLinks();
})();

// SW が寝ているとき最初の応答が null になる。null の間だけ数回リトライする。
async function checkPageWithRetry(host, tries = 5) {
  for (let i = 0; i < tries; i++) {
    const r = await checkMany([host]);
    if (r) return !!r[host];
    await new Promise((s) => setTimeout(s, 150 * (i + 1)));
  }
  return false;
}

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

// blur 中のページに報告ボタンを出す。body は blur されるので documentElement 直下
// （body の外）に置いて blur を回避する。クリックで報告ページを新タブで開く。
function addReportButton() {
  if (document.getElementById("aiblocker-report")) return;
  const box = document.createElement("div");
  box.id = "aiblocker-report";
  box.style.cssText =
    "position:fixed;bottom:12px;right:12px;z-index:2147483647;" +
    "display:flex;gap:6px;font-family:system-ui,sans-serif;";

  const mk = (label, vote) => {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText =
      "padding:6px 10px;font-size:12px;border:1px solid #ccc;border-radius:6px;" +
      "background:#fff;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.2);";
    b.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "openReport", host: location.hostname, vote });
    });
    return b;
  };

  box.appendChild(mk("🙅 AIじゃない", -1));
  box.appendChild(mk("🤖 AIだと再報告", 1));
  document.documentElement.appendChild(box);
}

let blurObserver = null;

// blur を適用し、SPA の hydration 等で class/style が剥がされても付け直す。
function applyBlur() {
  installBlur();
  if (blurObserver) return;
  blurObserver = new MutationObserver(() => installBlur());
  blurObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  if (document.head) blurObserver.observe(document.head, { childList: true });
}

// 冪等: style が無ければ挿し、class が無ければ付ける。
function installBlur() {
  if (!document.getElementById("aiblocker-style")) {
    const style = document.createElement("style");
    style.id = "aiblocker-style";
    style.textContent = `
      html.aiblocker-blur body { filter: blur(10px); transition: filter .15s ease; }
      html.aiblocker-blur body:hover { filter: blur(3px); }
    `;
    (document.head || document.documentElement).appendChild(style);
  }
  if (!document.documentElement.classList.contains("aiblocker-blur")) {
    document.documentElement.classList.add("aiblocker-blur");
  }
}
