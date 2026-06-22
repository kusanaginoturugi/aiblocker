// Bloom filter の照合側のみ。api/src/bloom.ts と完全に同一のアルゴリズムであること
// （直列化フォーマット・double hashing が一致しないと往復照合が破綻する）。

const MAGIC = 0x41494246; // "AIBF"
const VERSION = 1;

// 16 進文字列の先頭 8 文字 / 次の 8 文字を 32bit 値として取り出す。
function twoHashes(hex) {
  const h1 = parseInt(hex.slice(0, 8), 16) >>> 0;
  let h2 = parseInt(hex.slice(8, 16), 16) >>> 0;
  if (h2 === 0) h2 = 0x9e3779b9; // 0 だと分布が崩れるので黄金比定数で代替
  return [h1, h2];
}

export class BloomFilter {
  constructor(m, k, bits) {
    this.m = m;
    this.k = k;
    this.bits = bits;
  }

  // [magic(4) version(1) k(1) m(4 LE)] + ビット列
  static fromBytes(buf) {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (view.getUint32(0, true) !== MAGIC) throw new Error("bad magic");
    if (buf[4] !== VERSION) throw new Error(`unsupported version: ${buf[4]}`);
    const k = buf[5];
    const m = view.getUint32(6, true);
    return new BloomFilter(m, k, buf.slice(10));
  }

  indexes(hex) {
    const [h1, h2] = twoHashes(hex);
    const out = new Array(this.k);
    for (let i = 0; i < this.k; i++) {
      out[i] = ((h1 + i * h2) >>> 0) % this.m;
    }
    return out;
  }

  test(hex) {
    for (const idx of this.indexes(hex)) {
      if ((this.bits[idx >> 3] & (1 << (idx & 7))) === 0) return false;
    }
    return true;
  }
}
