// Portage exact de reliefstudio.write_stl (cas sans conge lateral) : meme ordre de
// triangles, memes normales, meme arithmetique float32 -> STL identique octet par
// octet a celui de Python (verifie par test_sas.py). Ne pas "simplifier" les
// Math.fround : ils reproduisent les arrondis float32 de numpy.
const f32 = Math.fround;

// Z quantifie : la page et Python partent du meme PNG 16 bits.
export function zFromU16(u16) {
  const Z = new Float32Array(u16.length);
  for (let i = 0; i < u16.length; i++) Z[i] = f32(u16[i] / 65535.0);
  return Z;
}

export function stlTriangleCount(NX, NY) {
  return 2 * (NX - 1) * (NY - 1) + (2 * NX + 2 * (NY - 2)) + 4 * (NX - 1) + 4 * (NY - 1);
}

// numpy.linspace(start, stop, num) en float64 puis converti en float32
function linspace32(start, stop, num) {
  const out = new Float32Array(num);
  const step = (stop - start) / (num - 1);
  for (let i = 0; i < num; i++) out[i] = f32(i * step + start);
  out[num - 1] = f32(stop);
  return out;
}

// Z : Float32Array (NY*NX, ligne 0 = haut de l'image) ; renvoie un ArrayBuffer STL binaire.
export function buildStl(Z, NX, NY, W, H, base, relief, onProgress) {
  const nTri = stlTriangleCount(NX, NY);
  const buf = new ArrayBuffer(84 + 50 * nTri);
  const bytes = new Uint8Array(buf);
  const hdr = "relief studio";
  for (let i = 0; i < hdr.length; i++) bytes[i] = hdr.charCodeAt(i);
  const dv = new DataView(buf);
  dv.setUint32(80, nTri, true);
  let off = 84;

  const rel = f32(relief), bas = f32(base);
  const top = new Float32Array(NX * NY);
  for (let i = 0; i < top.length; i++) top[i] = f32(f32(Z[i] * rel) + bas);
  const xs = linspace32(0, W, NX);
  const ys = linspace32(H, 0, NY);

  // un triangle : normale (numpy.cross float32, norme, division) puis 3 sommets
  function tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
    const ux = f32(bx - ax), uy = f32(by - ay), uz = f32(bz - az);
    const vx = f32(cx - ax), vy = f32(cy - ay), vz = f32(cz - az);
    let nx = f32(f32(uy * vz) - f32(uz * vy));
    let ny = f32(f32(uz * vx) - f32(ux * vz));
    let nz = f32(f32(ux * vy) - f32(uy * vx));
    const s = f32(f32(f32(nx * nx) + f32(ny * ny)) + f32(nz * nz));
    let L = f32(Math.sqrt(s));
    if (L < 1e-12) L = 1;
    nx = f32(nx / L); ny = f32(ny / L); nz = f32(nz / L);
    dv.setFloat32(off, nx, true); dv.setFloat32(off + 4, ny, true); dv.setFloat32(off + 8, nz, true);
    dv.setFloat32(off + 12, ax, true); dv.setFloat32(off + 16, ay, true); dv.setFloat32(off + 20, az, true);
    dv.setFloat32(off + 24, bx, true); dv.setFloat32(off + 28, by, true); dv.setFloat32(off + 32, bz, true);
    dv.setFloat32(off + 36, cx, true); dv.setFloat32(off + 40, cy, true); dv.setFloat32(off + 44, cz, true);
    off += 50;
  }

  // nappe, par paquets de 200 rangees comme write_stl(chunk=200) :
  // d'abord tous les (a, c, b) du paquet, puis tous les (a, d, c)
  const CHUNK = 200;
  for (let j0 = 0; j0 < NY - 1; j0 += CHUNK) {
    const j1 = Math.min(j0 + CHUNK, NY - 1);
    for (let pass = 0; pass < 2; pass++) {
      for (let j = j0; j < j1; j++) {
        const y0 = ys[j], y1 = ys[j + 1];
        for (let i = 0; i < NX - 1; i++) {
          const x0 = xs[i], x1 = xs[i + 1];
          const za = top[j * NX + i], zb = top[j * NX + i + 1];
          const zc = top[(j + 1) * NX + i + 1], zd = top[(j + 1) * NX + i];
          if (pass === 0) tri(x0, y0, za, x1, y1, zc, x1, y0, zb);
          else tri(x0, y0, za, x0, y1, zd, x1, y1, zc);
        }
      }
    }
    if (onProgress) onProgress(0.9 * j1 / (NY - 1));
  }

  // fond en eventail sur tous les points de bordure (pas de jonction en T)
  const rx = [], ry = [];
  for (let i = 0; i < NX; i++) { rx.push(xs[i]); ry.push(ys[0]); }
  for (let j = 1; j < NY - 1; j++) { rx.push(xs[NX - 1]); ry.push(ys[j]); }
  for (let i = NX - 1; i >= 0; i--) { rx.push(xs[i]); ry.push(ys[NY - 1]); }
  for (let j = NY - 2; j >= 1; j--) { rx.push(xs[0]); ry.push(ys[j]); }
  const cxm = f32(W / 2), cym = f32(H / 2), n = rx.length;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    tri(cxm, cym, 0, rx[k], ry[k], 0, rx[k2], ry[k2], 0);
  }

  // parois : tous les A puis tous les B, comme write_stl.wall
  function wall(px, py, pz, flip) {
    const m = px.length;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < m - 1; i++) {
        const t1 = [px[i], py[i], pz[i]], t2 = [px[i + 1], py[i + 1], pz[i + 1]];
        const fa = [px[i], py[i], 0], fb = [px[i + 1], py[i + 1], 0];
        let A, B, C;
        if (flip) [A, B, C] = pass === 0 ? [t1, fb, fa] : [t1, t2, fb];
        else [A, B, C] = pass === 0 ? [t1, fa, fb] : [t1, fb, t2];
        tri(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2]);
      }
    }
  }
  const row = (j) => top.subarray(j * NX, (j + 1) * NX);
  const col = (i) => { const c = new Float32Array(NY); for (let j = 0; j < NY; j++) c[j] = top[j * NX + i]; return c; };
  wall(xs, new Float32Array(NX).fill(ys[0]), row(0), true);
  wall(xs, new Float32Array(NX).fill(ys[NY - 1]), row(NY - 1), false);
  wall(new Float32Array(NY).fill(xs[0]), ys, col(0), false);
  wall(new Float32Array(NY).fill(xs[NX - 1]), ys, col(NX - 1), true);

  if (off !== buf.byteLength) throw new Error("STL : taille inattendue " + off + " / " + buf.byteLength);
  if (onProgress) onProgress(1);
  return buf;
}
