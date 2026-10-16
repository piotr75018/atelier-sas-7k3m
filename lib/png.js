// Decodeur PNG gris 8/16 bits (non entrelace) : un canvas ramenerait les 16 bits a 8.
// Sert dans la page et sous node (test_sas.py) : DecompressionStream existe dans les deux.

async function inflate(data) {
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([data]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

// renvoie {width, height, depth, data} ; data = Uint16Array (16 bits) ou Uint8Array (8 bits)
export async function decodeGrayPng(buffer) {
  const b = new Uint8Array(buffer);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (b[i] !== sig[i]) throw new Error("pas un PNG");
  let pos = 8, width = 0, height = 0, depth = 0, ctype = 0;
  const idat = [];
  while (pos < b.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]);
    const body = b.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12);
      depth = b[pos + 16]; ctype = b[pos + 17];
      if (b[pos + 20] !== 0) throw new Error("PNG entrelace non gere");
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (ctype !== 0 || (depth !== 8 && depth !== 16)) throw new Error("PNG gris 8/16 bits attendu");
  let total = 0;
  for (const c of idat) total += c.length;
  const z = new Uint8Array(total);
  let o = 0;
  for (const c of idat) { z.set(c, o); o += c.length; }
  const raw = await inflate(z);

  const bpp = depth / 8, stride = width * bpp;
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  const out = depth === 16 ? new Uint16Array(width * height) : new Uint8Array(width * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p++], a = i >= bpp ? cur[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (ft) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + up; break;
        case 3: v = x + ((a + up) >> 1); break;
        case 4: v = x + paeth(a, up, c); break;
        default: throw new Error("filtre PNG inconnu " + ft);
      }
      cur[i] = v & 255;
    }
    if (depth === 16) for (let i = 0; i < width; i++) out[y * width + i] = (cur[2 * i] << 8) | cur[2 * i + 1];
    else out.set(cur, y * width);
    prev.set(cur);
  }
  return { width, height, depth, data: out };
}
