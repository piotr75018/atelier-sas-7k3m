import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { downloadZip } from "client-zip";
import { importKey, decrypt, opaqueName } from "./lib/crypt.js";
import { decodeGrayPng } from "./lib/png.js";
import { zFromU16, buildStl } from "./lib/stl.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nf = (x, d = 1) => Number(x).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
const tick = () => new Promise((r) => setTimeout(r, 30));

// ------------------------------------------------------------------ donnees chiffrees
let KEY, KEYB64, IDX;
const files = new Map();
function getFile(name) {
  if (!files.has(name)) {
    files.set(name, (async () => {
      const path = name === "index.json" ? "data/index.bin" : "data/" + (await opaqueName(KEYB64, name));
      const r = await fetch(path);
      if (!r.ok) throw new Error("fichier introuvable : " + name);
      return decrypt(KEY, await r.arrayBuffer());
    })());
  }
  return files.get(name);
}
const heights = new Map();
function getZ(png) {
  if (!heights.has(png)) {
    heights.set(png, getFile(png).then(decodeGrayPng).then((im) => ({ NX: im.width, NY: im.height, data: im.data })));
  }
  return heights.get(png);
}

function status(msg) {
  const el = $("#status");
  el.hidden = !msg;
  el.textContent = msg || "";
}

// ------------------------------------------------------------------ etat dans le lien (#k=...&p=...&v=...)
function hashParams() { return new URLSearchParams(location.hash.slice(1)); }
let ROLE = "cnc";                 // "cnc" = bas-reliefs a usiner, "eb" = ebenisterie
function setHash(p, v) {
  const h = new URLSearchParams();
  h.set("k", KEYB64);
  h.set("r", ROLE);
  if (p) h.set("p", p);
  if (v) h.set("v", v);
  history.replaceState(null, "", "#" + h.toString());
}

// ------------------------------------------------------------------ vue 3D
const canvas = $("#viewer");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 1, 50000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xfff6ea, 0x6b5a48, 1.2));
const key = new THREE.DirectionalLight(0xffffff, 1.7);
key.position.set(-0.6, 0.5, 1);
camera.add(key);
scene.add(camera);
let content = new THREE.Group();
scene.add(content);

const WOOD = new THREE.Color(0xc9a678), WOOD_DARK = new THREE.Color(0xa98559);
const matCarved = new THREE.MeshStandardMaterial({ color: WOOD, roughness: 0.8, side: THREE.DoubleSide });
const matPlain = new THREE.MeshStandardMaterial({ color: WOOD_DARK, roughness: 0.85, side: THREE.DoubleSide });
const matVertex = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, side: THREE.DoubleSide });
const matHover = new THREE.MeshStandardMaterial({ color: 0xe0b070, roughness: 0.7, side: THREE.DoubleSide });
const matGhost = new THREE.MeshStandardMaterial({ color: WOOD_DARK, roughness: 0.9, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide });

function applyBackground() {
  renderer.setClearColor(getComputedStyle(document.documentElement).getPropertyValue("--viewer").trim() || "#e9e4dc");
}
applyBackground();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyBackground);

function resize() {
  const r = canvas.parentElement.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(r.height, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas.parentElement);

function disposeTree(o) {
  o.traverse((m) => { if (m.geometry) m.geometry.dispose(); });
}
function setContent(obj, dir) {
  scene.remove(content);
  disposeTree(content);
  content = obj;
  scene.add(obj);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
  const r = size.length() / 2;
  const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.9;
  camera.position.copy(ctr).add(dir.clone().normalize().multiplyScalar(dist));
  camera.near = dist / 100; camera.far = dist * 10;
  camera.updateProjectionMatrix();
  controls.target.copy(ctr);
  controls.update();
}
function loop() {
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(loop);
}

// survol / clic dans la vue montee
const ray = new THREE.Raycaster(), mouse = new THREE.Vector2();
let hovered = null, downAt = null;
function pickAt(ev) {
  const r = canvas.getBoundingClientRect();
  mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const hit = ray.intersectObjects(content.children, false)[0];
  return hit && hit.object.userData.pid ? hit.object : null;
}
canvas.addEventListener("pointermove", (ev) => {
  if (!content.userData.pickable) return;
  const o = pickAt(ev);
  if (o === hovered) return;
  if (hovered) hovered.material = hovered.userData.mat;
  hovered = o;
  if (o) o.material = matHover;
  canvas.style.cursor = o ? "pointer" : "";
  $("#viewer-msg").textContent = "";
  if (o) canvas.title = nameOf(o.userData.pid);
});
canvas.addEventListener("pointerdown", (ev) => { downAt = [ev.clientX, ev.clientY]; });
canvas.addEventListener("pointerup", (ev) => {
  if (!content.userData.pickable || !downAt) return;
  if (Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4) return;
  const o = pickAt(ev);
  if (o) go(o.userData.pid);
});

// ------------------------------------------------------------------ geometries
function parseAssembly(buf) {
  const dv = new DataView(buf);
  const hl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  const base = 4 + hl;
  return head.map((p) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(buf, base + p.v[0], p.v[1] * 3), 3));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(buf, base + p.t[0], p.t[1] * 3), 1));
    g.computeVertexNormals();
    return { id: p.id, geometry: g };
  });
}

function stlGeometry(buf) {
  const dv = new DataView(buf);
  const n = dv.getUint32(80, true);
  const pos = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const o = 84 + 50 * i + 12;
    for (let k = 0; k < 9; k++) pos[9 * i + k] = dv.getFloat32(o + 4 * k, true);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

function pick(N, step) {
  const out = [];
  for (let i = 0; i < N; i += step) out.push(i);
  if (out[out.length - 1] !== N - 1) out.push(N - 1);
  return out;
}

// relief allege pour l'affichage (le STL telecharge, lui, est a pleine definition)
function reliefObject(z, v, map) {
  const { NX, NY, data } = z;
  const step = Math.max(1, Math.ceil(Math.max(NX, NY) / 900));
  const ri = pick(NY, step), ci = pick(NX, step);
  const nr = ri.length, nc = ci.length;
  const pos = new Float32Array(nr * nc * 3), col = new Float32Array(nr * nc * 3);
  const thr = IDX.seuil_reste_mm;
  const c0 = WOOD, c1 = new THREE.Color(0xe0a020), c2 = new THREE.Color(0xc0392b), tmp = new THREE.Color();
  let p = 0;
  for (const r of ri) {
    for (const c of ci) {
      const zz = v.base + v.relief * data[r * NX + c] / 65535;
      pos[p] = c / (NX - 1) * v.W; pos[p + 1] = v.H * (1 - r / (NY - 1)); pos[p + 2] = zz;
      tmp.copy(c0);
      if (map) {
        const mr = Math.min(map.height - 1, Math.round(r * (map.height - 1) / (NY - 1)));
        const mc = Math.min(map.width - 1, Math.round(c * (map.width - 1) / (NX - 1)));
        const mm = map.data[mr * map.width + mc] / 255;      // carte : 0..1 mm de matiere restante
        if (mm > thr) tmp.copy(c1).lerp(c2, Math.min(1, (mm - thr) / 0.5));
      }
      col[p] = tmp.r; col[p + 1] = tmp.g; col[p + 2] = tmp.b;
      p += 3;
    }
  }
  const idx = new Uint32Array((nr - 1) * (nc - 1) * 6);
  let q = 0;
  for (let i = 0; i < nr - 1; i++) {
    for (let j = 0; j < nc - 1; j++) {
      const a = i * nc + j, b = a + 1, d = a + nc, c = d + 1;
      idx.set([a, c, b, a, d, c], q);
      q += 6;
    }
  }
  const top = new THREE.BufferGeometry();
  top.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  top.setAttribute("color", new THREE.BufferAttribute(col, 3));
  top.setIndex(new THREE.BufferAttribute(idx, 1));
  top.computeVertexNormals();

  // parois + dessous
  const ring = [];
  for (let j = 0; j < nc; j++) ring.push(j);
  for (let i = 1; i < nr; i++) ring.push(i * nc + nc - 1);
  for (let j = nc - 2; j >= 0; j--) ring.push((nr - 1) * nc + j);
  for (let i = nr - 2; i >= 1; i--) ring.push(i * nc);
  const m = ring.length, sp = new Float32Array((2 * m + 1) * 3);
  ring.forEach((k, i) => {
    sp.set([pos[3 * k], pos[3 * k + 1], pos[3 * k + 2]], 3 * i);
    sp.set([pos[3 * k], pos[3 * k + 1], 0], 3 * (m + i));
  });
  sp.set([v.W / 2, v.H / 2, 0], 6 * m);
  const si = [];
  for (let i = 0; i < m; i++) {
    const a = i, b = (i + 1) % m;
    si.push(a, b + m, b, a, a + m, b + m, 2 * m, b + m, a + m);
  }
  const sides = new THREE.BufferGeometry();
  sides.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  sides.setIndex(si);
  sides.computeVertexNormals();
  const g = new THREE.Group();
  g.add(new THREE.Mesh(top, matVertex), new THREE.Mesh(sides, matPlain));
  return g;
}

// ------------------------------------------------------------------ navigation
const NAV = [];
function nameOf(pid) {
  if (IDX.planches[pid]) return IDX.planches[pid].nom;
  const l = IDX.lisses.find((x) => x.id === pid);
  return l ? l.nom : pid;
}
const isPlanche = (pid) => !!IDX.planches[pid];
function setRole(r) {
  ROLE = r;
  for (const b of document.querySelectorAll("#roles button")) b.classList.toggle("on", b.dataset.r === r);
  $("#dl-all").hidden = r !== "cnc";
  buildNav();
}
function buildNav() {
  const nav = $("#nav");
  nav.innerHTML = "";
  const add = (pid, label, badge) => {
    const b = document.createElement("button");
    b.dataset.pid = pid;
    b.innerHTML = `<span>${esc(label)}</span>${badge ? `<span class="badge warn">${esc(badge)}</span>` : ""}`;
    b.onclick = () => go(pid);
    nav.appendChild(b);
  };
  const h = (t) => { const e = document.createElement("h4"); e.textContent = t; nav.appendChild(e); };
  if (ROLE === "cnc") {
    add("", "Vue d'ensemble CNC");
    h("Bas-reliefs à usiner");
    for (const pid of IDX.ordre) add(pid, IDX.planches[pid].nom);
  } else {
    add("", "Chaise montée");
    add("debit", "Liste de débit");
    h("Pièces lisses");
    for (const p of IDX.lisses) add(p.id, p.nom, p.a_confirmer ? "à confirmer" : "");
  }
}
function markNav(pid) {
  for (const b of document.querySelectorAll("#nav button")) b.classList.toggle("active", b.dataset.pid === pid);
}

let current = { pid: "", vid: "F1", tool: null };
async function go(pid, vid) {
  current = { pid, vid: vid || current.vid || "F1", tool: null };
  if (pid) { const r = isPlanche(pid) ? "cnc" : "eb"; if (r !== ROLE || !$("#nav").children.length) setRole(r); }
  setHash(pid, current.vid);
  markNav(pid);
  hovered = null;
  canvas.style.cursor = "";
  canvas.title = "";
  if (!pid) return showChair();
  if (pid === "debit") return showDebit();
  if (IDX.planches[pid]) return showPlanche();
  return showLisse(pid);
}

// ------------------------------------------------------------------ vues
let assembly = null;
// chaise montee : en CNC seules les planches sculptees sont cliquables (le reste en fantome),
// en ebenisterie seules les pieces lisses le sont
async function showChair() {
  $("#panel").innerHTML = ROLE === "cnc" ? cncPanel() : ebPanel();
  $("#viewer-msg").textContent = "Chargement de la chaise…";
  await drawAssembly();
  if (current.pid !== "") return;
  $("#viewer-msg").textContent = "";
}

async function drawAssembly() {
  if (!assembly) assembly = parseAssembly(await getFile(IDX.assemblage));
  const g = new THREE.Group();
  for (const p of assembly) {
    const carved = isPlanche(p.id);
    const mine = (ROLE === "cnc") === carved;
    const mat = carved ? matCarved : matPlain;
    const mesh = new THREE.Mesh(p.geometry.clone(), mine ? mat : ROLE === "cnc" ? matGhost : mat);
    mesh.userData = mine ? { pid: p.id, mat } : {};
    g.add(mesh);
  }
  g.userData.pickable = true;
  g.userData.role = ROLE;
  setContent(g, new THREE.Vector3(1.1, -1.6, 0.9));
}

function cncPanel() {
  const prov = Object.values(IDX.variantes).some((v) => v.provisoire);
  const rows = IDX.ordre.map((pid) => {
    const v = IDX.planches[pid].variantes.F1;
    return `<tr class="pick" data-go="${pid}"><td>${esc(IDX.planches[pid].nom)}</td><td class="num">${nf(v.W)} × ${nf(v.H)}</td><td class="num">${nf(v.diag.reco.brut.ep_min)}</td></tr>`;
  }).join("");
  setTimeout(() => document.querySelectorAll("[data-go]").forEach((tr) => (tr.onclick = () => go(tr.dataset.go))));
  return `
    <h2>Usinage CNC · bas-reliefs</h2>
    <p class="muted small">Seuls les ${IDX.ordre.length} motifs en bas-relief sont à usiner. Cliquez une planche (sur la chaise ou dans la liste) pour la voir seule, la télécharger et lire son diagnostic.</p>
    ${prov ? '<div class="note">Les réglages des deux finitions sont encore <b>provisoires</b> : les fichiers seront remplacés à la même adresse.</div>' : ""}
    <ul class="small">
      <li>STL binaires en <b>millimètres</b>, une planche par fichier, chacune en ${Object.keys(IDX.variantes).length} finitions (${Object.entries(IDX.variantes).map(([k, v]) => `${k} = ${esc(v.nom)}`).join(", ")}).</li>
      <li>Repère : X = largeur, Y = hauteur de l'image (<b>sens du fil</b>), Z = épaisseur ; dessous de la planche à Z = 0, coin bas-gauche à l'origine.</li>
      <li>Le relief <b>ajoute</b> de la matière : le fond du motif est à l'épaisseur de la planche (24 mm), le motif au-dessus.</li>
      <li>Chaque planche a un diagnostic calculé sur sa surface réelle : brut, ébauche, fraise de finition, pas, zones que chaque fraise n'atteint pas.</li>
      <li>La heightmap 16 bits (noir = fond, blanc = relief maximal) est aussi téléchargeable pour Aspire / VCarve.</li>
      <li>Le bouton « Télécharger (.zip) » en haut réunit tous les STL des bas-reliefs. Les pièces lisses n'en font pas partie : elles concernent l'ébéniste.</li>
    </ul>
    <h3>Bas-reliefs à usiner</h3>
    <table><tr><th>Planche</th><th class="num">Cotes (mm)</th><th class="num">Brut ≥ (mm)</th></tr>${rows}</table>
    <p class="muted small">Généré le ${esc(IDX.genere)}.</p>`;
}

function ebPanel() {
  const lis = IDX.lisses.map((p) => `<tr class="pick" data-go="${p.id}"><td>${esc(p.nom)}${p.a_confirmer ? ' <span class="badge warn">à confirmer</span>' : ""}</td><td class="num">${p.dims.map((x) => nf(x)).join(" × ")}</td></tr>`).join("");
  setTimeout(() => {
    document.querySelectorAll("[data-go]").forEach((tr) => (tr.onclick = () => go(tr.dataset.go)));
    $("#lisses-zip").onclick = downloadLisses;
  });
  return `
    <h2>Ébénisterie</h2>
    <p class="muted small">Les bas-reliefs sont usinés par le prestataire CNC. Ici : le débit des pièces, le montage, et les pièces lisses. Cliquez une pièce lisse sur la chaise ou dans la liste.</p>
    <h3>Montage</h3>
    <ul class="small">${IDX.ebeniste.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
    <p><button class="btn primary" id="debit-btn" onclick="location.hash='k=${KEYB64}&r=eb&p=debit'">Liste de débit complète</button>
       <button class="btn" id="fiche-btn">Fiche texte (.txt)</button></p>
    <h3>Pièces lisses</h3>
    <table><tr><th>Pièce</th><th class="num">L × l × ép. (mm)</th></tr>${lis}</table>
    <p><button class="btn" id="lisses-zip">STL des pièces lisses (.zip)</button></p>
    ${IDX.ecarts.length ? `<h3>Cotes retenues</h3><ul class="small muted">${IDX.ecarts.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
    <p class="muted small">Généré le ${esc(IDX.genere)}.</p>`;
}

async function showPlanche() {
  const { pid } = current;
  const e = IDX.planches[pid];
  if (!e.variantes[current.vid]) current.vid = Object.keys(e.variantes)[0];
  renderPlanchePanel();
  await drawPlanche();
}

async function drawPlanche() {
  const { pid, vid, tool } = current;
  const v = IDX.planches[pid].variantes[vid];
  $("#viewer-msg").textContent = "Chargement du relief…";
  const z = await getZ(v.png);
  const map = tool ? await getFile(v.cartes[tool]).then(decodeGrayPng) : null;
  if (current.pid !== pid || current.vid !== vid || current.tool !== tool) return;
  const obj = reliefObject(z, v, map);
  const keep = content.userData.pid === pid && content.userData.vid === vid;
  if (keep) {
    const cam = camera.position.clone(), tgt = controls.target.clone();
    setContent(obj, new THREE.Vector3(0, -1, 1));
    camera.position.copy(cam); controls.target.copy(tgt); controls.update();
  } else setContent(obj, new THREE.Vector3(0.15, -0.9, 1.1));
  obj.userData.pid = pid; obj.userData.vid = vid;
  $("#viewer-msg").textContent = "";
}

function renderPlanchePanel() {
  const { pid, vid, tool } = current;
  const e = IDX.planches[pid], v = e.variantes[vid], d = v.diag, r = d.reco;
  const vars = Object.keys(e.variantes).map((k) => `<button class="${k === vid ? "on" : ""}" data-v="${k}">${esc(IDX.variantes[k].nom)}</button>`).join("");
  const prov = IDX.variantes[vid].provisoire;
  const toolRows = d.fraises.map((t) => {
    const cls = t.non_atteint_pct <= 1 ? "ok" : "bad";
    const isFin = t.id === r.finition.outil, isRep = r.reprise && t.id === r.reprise.outil;
    return `<tr class="pick ${t.id === tool ? "sel" : ""}" data-tool="${t.id}"><td>${esc(t.nom)}${isFin ? ' <span class="badge">finition</span>' : ""}${isRep ? ' <span class="badge">reprise</span>' : ""}</td>
      <td class="num ${cls}">${nf(t.non_atteint_pct, 2)} %</td><td class="num">${nf(t.reste_max_mm, 2)}</td></tr>`;
  }).join("");
  $("#panel").innerHTML = `
    <h2>${esc(e.nom)}</h2>
    <p class="muted small">${esc(e.sens)}</p>
    <div class="seg" role="group" aria-label="Finition">${vars}</div>
    ${prov ? '<span class="badge warn" style="margin-left:6px">réglages provisoires</span>' : ""}
    <dl class="kv">
      <dt>Cotes finies</dt><dd>${nf(v.W)} × ${nf(v.H)} mm</dd>
      <dt>Fond du relief</dt><dd>${nf(v.base)} mm du dessous</dd>
      <dt>Relief maximal</dt><dd>${nf(d.relief_max_mm, 2)} mm (sommet à ${nf(v.base + d.relief_max_mm, 2)} mm)</dd>
      <dt>Grille du STL</dt><dd>${nf(d.pas_grille_mm, 3)} mm · ${v.nx} × ${v.ny} points</dd>
      <dt>Triangles</dt><dd>${v.ntri.toLocaleString("fr-FR")} (${nf(v.stl_mo, 0)} Mo)</dd>
    </dl>
    <div class="dl-row">
      <button class="btn primary" id="dl-stl">Télécharger le STL</button>
      <button class="btn" id="dl-png">Heightmap 16 bits (.png)</button>
    </div>
    <h3>Diagnostic d'usinage</h3>
    <div class="card small"><b>Brut</b><p>${esc(r.brut.texte)}</p></div>
    <div class="card small"><b>Ébauche</b><p>${esc(r.ebauche)}</p></div>
    <div class="card small"><b>Finition</b><p>${esc(r.finition.texte)}</p></div>
    ${r.reprise ? `<div class="card small"><b>Reprise</b><p>${esc(r.reprise.texte)}</p></div>` : ""}
    ${r.ecartees.length ? `<p class="small muted"><b>Options plus simples écartées</b></p><ul class="small muted">${r.ecartees.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    <h3>Ce que chaque fraise atteint</h3>
    <p class="small muted">Simulation d'une fraise qui balaie toute la surface. « Non atteint » = part du motif où il reste plus de ${nf(IDX.seuil_reste_mm, 2)} mm de matière. Cliquez une ligne pour voir ces zones sur la pièce.</p>
    <table>
      <tr><th>Fraise</th><th class="num">Non atteint</th><th class="num">Reste max (mm)</th></tr>
      <tr class="pick ${tool ? "" : "sel"}" data-tool=""><td>Aucune carte</td><td></td><td></td></tr>
      ${toolRows}
    </table>
    <div class="legend" style="margin-top:8px"><span>${nf(IDX.seuil_reste_mm, 2)} mm</span><span class="bar"></span><span>≥ 0,55 mm restant</span></div>
    <p class="small muted">Pente du motif (99e centile) : ${nf(d.pente_p99_deg, 0)}° · motif : ${nf(d.motif_pct, 0)} % de la surface · avance supposée ${nf(IDX.avance_mm_min, 0)} mm/min pour les temps.</p>`;
  for (const b of document.querySelectorAll(".seg button")) b.onclick = () => { current.vid = b.dataset.v; current.tool = null; setHash(pid, current.vid); renderPlanchePanel(); drawPlanche(); };
  for (const tr of document.querySelectorAll("tr[data-tool]")) tr.onclick = () => { current.tool = tr.dataset.tool || null; renderPlanchePanel(); drawPlanche(); };
  $("#dl-stl").onclick = () => downloadStl(pid, current.vid);
  $("#dl-png").onclick = async () => save(new Blob([await getFile(v.png)], { type: "image/png" }), `chaise_${pid}_${vid}_heightmap16.png`);
}

async function showLisse(pid) {
  const p = IDX.lisses.find((x) => x.id === pid);
  $("#panel").innerHTML = `
    <h2>${esc(p.nom)} ${p.a_confirmer ? '<span class="badge warn">à confirmer</span>' : ""}</h2>
    <dl class="kv"><dt>Cotes</dt><dd>${p.dims.map((x) => nf(x)).join(" × ")} mm</dd></dl>
    ${p.note ? `<p class="small">${esc(p.note)}</p>` : ""}
    <div class="dl-row"><button class="btn primary" id="dl-lisse">Télécharger le STL</button></div>
    <p class="small muted">Pièce lisse, sans bas-relief : le STL sert de gabarit de débit et de contrôle.</p>`;
  $("#dl-lisse").onclick = async () => save(new Blob([await getFile(p.stl)]), `chaise_${p.stl}`);
  $("#viewer-msg").textContent = "Chargement…";
  const g = stlGeometry(await getFile(p.stl));
  if (current.pid !== pid) return;
  const grp = new THREE.Group();
  grp.add(new THREE.Mesh(g, matPlain));
  setContent(grp, new THREE.Vector3(0.6, -1, 0.8));
  $("#viewer-msg").textContent = "";
}

async function showDebit() {
  const lisse = (id) => IDX.lisses.some((l) => l.id === id);
  const rows = IDX.ebeniste.debit.map((x) => `<tr ${lisse(x.id) ? `class="pick" data-go="${x.id}"` : ""}><td>${esc(x.nom)}</td><td class="num">${nf(x.L)}</td><td class="num">${nf(x.l)}</td><td class="num">${nf(x.ep)}</td><td class="num">${nf(x.ep_brut)}</td><td class="small">${esc(x.type)}</td></tr>`).join("");
  $("#panel").innerHTML = `
    <h2>Liste de débit</h2>
    <p class="small muted">Cotes finies en mm. « Ép. brut » : épaisseur minimale du brut à raboter avant usinage (fond du relief + relief + 1 mm).</p>
    <table><tr><th>Pièce</th><th class="num">L</th><th class="num">l</th><th class="num">Ép.</th><th class="num">Ép. brut</th><th></th></tr>${rows}</table>
    <h3>Notes de montage</h3>
    <ul class="small">${IDX.ebeniste.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
    <h3>Fiche du piètement</h3>
    <pre class="fiche">${esc(IDX.pietement_fiche)}</pre>`;
  document.querySelectorAll("[data-go]").forEach((tr) => (tr.onclick = () => go(tr.dataset.go)));
  if (content.userData.role !== "eb") await drawAssembly();
}

// ------------------------------------------------------------------ telechargements
function save(blob, name) {
  const a = document.createElement("a");
  const url = URL.createObjectURL(blob);
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function makeStl(pid, vid, label) {
  const v = IDX.planches[pid].variantes[vid];
  status(`${label || IDX.planches[pid].nom} : préparation du relief…`);
  const z = await getZ(v.png);
  status(`${label || IDX.planches[pid].nom} : génération du STL (${v.ntri.toLocaleString("fr-FR")} triangles)…`);
  await tick();
  return buildStl(zFromU16(z.data), z.NX, z.NY, v.W, v.H, v.base, v.relief);
}

async function downloadStl(pid, vid) {
  try {
    const buf = await makeStl(pid, vid);
    save(new Blob([buf], { type: "model/stl" }), `chaise_${pid}_${vid}.stl`);
    status("");
  } catch (err) { status("Erreur : " + err.message); }
}

async function* zipEntries(vids) {
  const now = new Date();
  yield { name: "LISEZMOI_fiche.txt", input: await getFile(IDX.fiche), lastModified: now };
  for (const vid of vids) {
    for (const [i, pid] of IDX.ordre.entries()) {
      const label = `${vid} · ${i + 1}/${IDX.ordre.length} · ${IDX.planches[pid].nom}`;
      const v = IDX.planches[pid].variantes[vid];
      yield { name: `${vid}_${IDX.variantes[vid].nom.replace(/\s+/g, "_")}/${pid}_${vid}.stl`, input: new Uint8Array(await makeStl(pid, vid, label)), lastModified: now };
      yield { name: `${vid}_${IDX.variantes[vid].nom.replace(/\s+/g, "_")}/heightmaps/${pid}_${vid}_heightmap16.png`, input: await getFile(v.png), lastModified: now };
    }
  }
}

async function downloadLisses() {
  try {
    const now = new Date();
    const entries = [];
    for (const p of IDX.lisses) entries.push({ name: p.stl, input: await getFile(p.stl), lastModified: now });
    save(await downloadZip(entries).blob(), "chaise_pieces_lisses.zip");
  } catch (err) { status("Erreur : " + err.message); }
}

async function downloadAll() {
  const vids = $("#zip-var").value.split(",");
  const name = `chaise_usinage_${vids.join("_")}.zip`;
  const btn = $("#zip-btn");
  btn.disabled = true;
  try {
    let writable = null;
    if (window.showSaveFilePicker) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: "Archive zip", accept: { "application/zip": [".zip"] } }] });
        writable = await h.createWritable();
      } catch (err) {
        if (err.name === "AbortError") return;
      }
    }
    const resp = downloadZip(zipEntries(vids));
    if (writable) await resp.body.pipeTo(writable);
    else save(await resp.blob(), name);
    status("Archive enregistrée.");
    setTimeout(() => status(""), 4000);
  } catch (err) {
    status("Erreur : " + err.message);
  } finally {
    btn.disabled = false;
  }
}

// ------------------------------------------------------------------ demarrage
function fatal(html) {
  document.body.innerHTML = `<div class="fatal">${html}</div>`;
}

async function main() {
  const k = hashParams().get("k");
  if (!k) return fatal("<h2>Lien incomplet</h2><p>Ce lien doit se terminer par <code>#k=…</code>. Utilisez le lien complet qui vous a été envoyé.</p>");
  KEYB64 = k;
  try {
    KEY = await importKey(k);
    IDX = JSON.parse(new TextDecoder().decode(await getFile("index.json")));
  } catch (err) {
    return fatal("<h2>Lien invalide</h2><p>Les fichiers n'ont pas pu être ouverts avec ce lien. Vérifiez qu'il a été copié en entier.</p>");
  }
  document.title = IDX.titre + " · sas d'usinage";
  $("#titre").textContent = IDX.titre + " · sas d'usinage";
  $("#sous-titre").textContent = `${IDX.ordre.length} bas-reliefs × ${Object.keys(IDX.variantes).length} finitions · généré le ${IDX.genere}`;
  for (const b of document.querySelectorAll("#roles button")) b.onclick = () => { setRole(b.dataset.r); go(""); };
  const sel = $("#zip-var");
  sel.innerHTML = Object.entries(IDX.variantes).map(([k2, v]) => `<option value="${k2}">${esc(v.nom)}</option>`).join("") +
    `<option value="${Object.keys(IDX.variantes).join(",")}">Toutes les finitions</option>`;
  $("#zip-btn").disabled = false;
  $("#zip-btn").onclick = downloadAll;
  document.addEventListener("click", async (ev) => {
    if (ev.target && ev.target.id === "fiche-btn") save(new Blob([await getFile(IDX.fiche)], { type: "text/plain" }), "chaise_fiche.txt");
  });
  window.addEventListener("hashchange", () => {
    const h = hashParams();
    const r = h.get("r") === "eb" ? "eb" : "cnc";
    if (r !== ROLE) setRole(r);
    if ((h.get("p") || "") !== current.pid || (!current.pid && r !== content.userData.role)) go(h.get("p") || "", h.get("v") || undefined);
  });
  resize();
  loop();
  const h = hashParams();
  setRole(h.get("r") === "eb" ? "eb" : "cnc");
  go(h.get("p") || "", h.get("v") || undefined);
}
main();
