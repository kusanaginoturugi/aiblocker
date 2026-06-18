// 依存なしの Bloom filter。
// 入力は SHA-256 の 16 進文字列（既に一様分布）なので、その先頭バイトから
// 2 つの 32bit 値を取り出し、double hashing (Kirsch-Mitzenmacher) でビットを立てる。
// バイト列に直列化して KV に焼き、拡張側は同じコードで照合する。

const MAGIC = 0x41494246; // "AIBF"
const VERSION = 1;

export interface BloomParams {
  m: number; // ビット数
  k: number; // ハッシュ関数の数
}

// 期待件数 n と目標偽陽性率 p から最適な m, k を求める。
export function optimalParams(n: number, p: number): BloomParams {
  const safeN = Math.max(1, n);
  const m = Math.ceil((-safeN * Math.log(p)) / (Math.LN2 * Math.LN2));
  const k = Math.max(1, Math.round((m / safeN) * Math.LN2));
  return { m, k };
}

// 16 進文字列の先頭 8 文字 / 次の 8 文字を 32bit 値として取り出す。
function twoHashes(hex: string): [number, number] {
  const h1 = parseInt(hex.slice(0, 8), 16) >>> 0;
  let h2 = parseInt(hex.slice(8, 16), 16) >>> 0;
  if (h2 === 0) h2 = 0x9e3779b9; // 0 だと分布が崩れるので黄金比定数で代替
  return [h1, h2];
}

export class BloomFilter {
  readonly m: number;
  readonly k: number;
  readonly bits: Uint8Array;

  constructor(m: number, k: number, bits?: Uint8Array) {
    this.m = m;
    this.k = k;
    this.bits = bits ?? new Uint8Array(Math.ceil(m / 8));
  }

  static create(n: number, p: number): BloomFilter {
    const { m, k } = optimalParams(n, p);
    return new BloomFilter(m, k);
  }

  private indexes(hex: string): number[] {
    const [h1, h2] = twoHashes(hex);
    const out = new Array<number>(this.k);
    for (let i = 0; i < this.k; i++) {
      out[i] = ((h1 + i * h2) >>> 0) % this.m;
    }
    return out;
  }

  add(hex: string): void {
    for (const idx of this.indexes(hex)) {
      this.bits[idx >> 3] |= 1 << (idx & 7);
    }
  }

  test(hex: string): boolean {
    for (const idx of this.indexes(hex)) {
      if ((this.bits[idx >> 3] & (1 << (idx & 7))) === 0) return false;
    }
    return true;
  }

  // [magic(4) version(1) k(1) m(4 LE)] + ビット列
  toBytes(): Uint8Array {
    const header = 10;
    const buf = new Uint8Array(header + this.bits.length);
    const view = new DataView(buf.buffer);
    view.setUint32(0, MAGIC, true);
    buf[4] = VERSION;
    buf[5] = this.k;
    view.setUint32(6, this.m, true);
    buf.set(this.bits, header);
    return buf;
  }

  static fromBytes(buf: Uint8Array): BloomFilter {
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (view.getUint32(0, true) !== MAGIC) throw new Error("bad magic");
    if (buf[4] !== VERSION) throw new Error(`unsupported version: ${buf[4]}`);
    const k = buf[5];
    const m = view.getUint32(6, true);
    return new BloomFilter(m, k, buf.slice(10));
  }
}
