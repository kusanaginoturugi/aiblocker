// 現ページの登録ドメインがリスト入りか background に問い合わせ、ヒットなら blur。
// このスクリプト自体はネットワーク通信をしない（判定は background の Bloom で完結）。

chrome.runtime.sendMessage({ type: "check", host: location.hostname }, (res) => {
  if (chrome.runtime.lastError) return; // SW 起動前等は黙って諦める
  if (res?.hit) applyBlur();
});

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
