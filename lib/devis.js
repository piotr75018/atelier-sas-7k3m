// Page « Devis » : demande de devis detaillee + grille de reponse du prestataire.
// Rien ne part du navigateur : le prestataire imprime en PDF ou telecharge un .json et vous le renvoie.
// Le brouillon est gardé dans le navigateur (localStorage) pour ne pas perdre la saisie.

import { importPublicKey, seal, sha256hex, extOf, TYPES, MAX_OCTETS } from "./depot.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const nf = (x, d = 1) => Number(x).toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (v) => { const x = parseFloat(String(v ?? "").replace(/\s/g, "").replace(",", ".")); return Number.isFinite(x) ? x : 0; };
const euro = (x) => nf(x, 2) + " €";
const hm = (min) => (min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}` : `${min} min`);

// lignes globales du poste CNC (une seule fois, quelle que soit la finition)
const GLOBAL_CNC = [
  ["fao", "Programmation / FAO", "trajectoires à partir des STL, une fois"],
  ["outils", "Outillage spécial", "fraises coniques à bout rond, si absentes de l'atelier"],
  ["transport", "Emballage et transport", "6 panneaux sculptés, à protéger du frottement sur le relief"],
];

export function mountDevis(root, IDX, { save, actions = {} }) {
  const D = IDX.devis;
  const KEY = "sas-devis:" + IDX.genere;
  const fins = Object.keys(D.cnc);
  let S = { role: "both", id: {}, cond: { tva: "20", validite: "30", acompte: "30", inclus: {} }, prix: {} };
  try { S = Object.assign(S, JSON.parse(localStorage.getItem(KEY) || "{}")); } catch (e) { /* navigateur sans stockage : on travaille sans */ }
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* idem */ } };
  const P = (k) => num(S.prix[k]);

  const inp = (cls, key, extra = "") =>
    `<input class="in ${cls}" inputmode="decimal" data-p="${esc(key)}" value="${esc(S.prix[key] ?? "")}" placeholder="0,00" ${extra}>`;
  const field = (label, path, type = "text") =>
    `<label class="fld"><span>${esc(label)}</span><input type="${type}" data-id="${path}" value="${esc(S.id[path] ?? "")}"></label>`;

  const cncRows = () => D.cnc[fins[0]].lignes.map((l, i) => {
    const tmin = (vid) => D.cnc[vid].lignes[i].temps_total_min;
    const det = (vid) => {
      const x = D.cnc[vid].lignes[i];
      return `<li><b>${esc(IDX.variantes[vid].nom)}</b> : ébauche ${x.ebauche.outil}, ${x.ebauche.passes} passes (${hm(x.ebauche.temps_min)}) ; ` +
        `finition ${esc(x.finition.outil)}, pas ${nf(x.finition.pas_mm, 2)} mm, crête ${nf(x.finition.crete_mm, 2)} mm (${hm(x.finition.temps_min)})` +
        (x.reprise ? ` ; reprise ${esc(x.reprise.outil)}, pas ${nf(x.reprise.pas_mm, 2)} mm (${hm(x.reprise.temps_min)})` : "") + `</li>`;
    };
    return `<tr>
      <td><b>${i + 1}. ${esc(l.nom)}</b><br><span class="muted small">${nf(l.W, 0)} × ${nf(l.H, 0)} mm · brut raboté ≥ ${nf(l.ep_brut)} mm</span>
        <details class="more"><summary>Outils et temps</summary><ul class="small">${fins.map(det).join("")}</ul></details></td>
      <td class="num">${inp("pr", "mat|" + l.id)}</td>
      ${fins.map((v) => `<td class="num"><span class="muted small">≈ ${hm(tmin(v))}</span><br>${inp("pr", "cnc|" + l.id + "|" + v)}</td>`).join("")}
    </tr>`;
  }).join("");

  const globRows = GLOBAL_CNC.map(([id, nom, pre]) =>
    `<tr><td><b>${esc(nom)}</b><br><span class="muted small">${esc(pre)}</span></td><td class="num">${inp("pr", "glob|" + id)}</td><td colspan="${fins.length}" class="muted small">commun aux deux finitions</td></tr>`).join("");

  const ebRows = D.eb.debit.map((x) =>
    `<tr><td><b>${esc(x.nom)}</b><br><span class="muted small">${esc(x.type)}</span></td>
      <td class="num small">${nf(x.L)} × ${nf(x.l)} × ${nf(x.ep)}<br><span class="muted">brut ≥ ${nf(x.ep_brut)}</span></td>
      <td class="num">${inp("pr", "eb|" + x.id)}</td></tr>`).join("");
  const ebTasks = D.eb.taches.map((t) =>
    `<tr><td><b>${esc(t.nom)}</b><br><span class="muted small">${esc(t.precision)}</span></td><td></td><td class="num">${inp("pr", "ebt|" + t.id)}</td></tr>`).join("");

  root.innerHTML = `
  <div class="devis-doc">
    <div class="devis-head">
      <div>
        <h2>Demande de devis · ${esc(IDX.titre)}</h2>
        <p class="muted small">Référence <b>SAS-${esc(IDX.genere)}</b> · fichiers du ${esc(IDX.genere)}. Chiffrez au regard des cotes ci-dessous ; les STL sont dans l'onglet « Usinage CNC ».</p>
      </div>
      <div class="dv-actions noprint">
        <button class="btn primary" id="dv-pdf">Enregistrer en PDF</button>
        <button class="btn" id="dv-json">Télécharger (.json)</button>
        <button class="btn" id="dv-reset">Effacer la saisie</button>
      </div>
    </div>

    <div class="dv-who noprint">Je chiffre :
      <div class="seg" id="dv-role">
        <button data-q="cnc">Usinage CNC</button><button data-q="eb">Ébénisterie</button><button data-q="both">Les deux</button>
      </div>
    </div>

    <div class="dv-docs noprint">
      <div data-sec="cnc"><b>Vos fichiers (CNC)</b> :
        <button class="btn" data-act="stl">Les ${D.cnc[fins[0]].lignes.length} STL (.zip, finition choisie en haut)</button>
        <button class="btn" data-act="cnc">Voir les panneaux et conseils d'usinage</button></div>
      <div data-sec="eb"><b>Vos fichiers (ébénisterie)</b> :
        <button class="btn" data-act="debit">Liste de débit</button>
        <button class="btn" data-act="lisses">STL des pièces lisses</button>
        <button class="btn" data-act="fiche">Fiche texte</button></div>
    </div>

    <h3>Prestataire</h3>
    <div class="dv-grid">${field("Société", "societe")}${field("Contact", "contact")}${field("E-mail", "email", "email")}${field("Téléphone", "tel", "tel")}</div>

    <section data-sec="cnc">
      <h3>1. Usinage CNC des six panneaux sculptés (€ HT)</h3>
      <p class="small muted">Relief ajouté sur un fond de 24 mm. Chaque finition est un prix à part : ${fins.map((v) => `<b>${esc(IDX.variantes[v].nom)}</b> (${esc(IDX.variantes[v].resume || "")})`).join(" · ")}. Les temps affichés sont une estimation de bureau, pas un engagement.</p>
      <table class="dv-table">
        <tr><th>Panneau</th><th class="num">Matière<br>(brut raboté)</th>${fins.map((v) => `<th class="num">Usinage<br>${esc(IDX.variantes[v].nom)}</th>`).join("")}</tr>
        ${cncRows()}
        ${globRows}
        ${fins.map((v) => `<tr class="tot"><td colspan="2">Total HT · ${esc(IDX.variantes[v].nom)}</td><td colspan="${fins.length}" class="num"><b data-tot="cnc|${v}">0,00 €</b>
          <span class="muted small"> · ≈ ${hm(D.cnc[v].temps_total_min)} de machine</span></td></tr>`).join("")}
      </table>
    </section>

    <section data-sec="eb">
      <h3>2. Ébénisterie (€ HT)</h3>
      <p class="small muted">Cotes finies en mm (L × l × ép.). Les bas-reliefs arrivent usinés du prestataire CNC.</p>
      <table class="dv-table">
        <tr><th>Pièce / tâche</th><th class="num">Cotes</th><th class="num">Prix HT<br>(débit + rabotage)</th></tr>
        ${ebRows}${ebTasks}
        <tr class="tot"><td colspan="2">Total HT ébénisterie</td><td class="num"><b data-tot="eb">0,00 €</b></td></tr>
      </table>
      <ul class="small">${IDX.ebeniste.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
    </section>

    <h3>Conditions</h3>
    <div class="dv-grid">
      ${field("Délai (semaines)", "delai")}
      <label class="fld"><span>Validité de l'offre (jours)</span><input data-c="validite" value="${esc(S.cond.validite)}"></label>
      <label class="fld"><span>Acompte (%)</span><input data-c="acompte" value="${esc(S.cond.acompte)}"></label>
      <label class="fld"><span>TVA (%)</span><input data-c="tva" value="${esc(S.cond.tva)}"></label>
    </div>
    <div class="dv-inc small">
      ${[["matiere", "Matière fournie par le prestataire"], ["bridage", "Surlongueur de bridage et détourage inclus"], ["transport", "Emballage et transport inclus"]]
        .map(([k, t]) => `<label><input type="checkbox" data-inc="${k}" ${S.cond.inclus[k] ? "checked" : ""}> ${esc(t)}</label>`).join("")}
    </div>
    <label class="fld wide"><span>Réserves, questions, alternatives proposées</span><textarea data-id="notes" rows="4">${esc(S.id.notes ?? "")}</textarea></label>

    <h3>Récapitulatif</h3>
    <table class="dv-table dv-recap" id="dv-recap"></table>

    <section class="dv-depot noprint">
      <h3>Déposer votre devis</h3>
      ${IDX.depot && IDX.depot.url ? `
      <p class="small muted">Joignez votre devis (PDF, Excel, Word ou image, 20 Mo au plus). Il est chiffré dans votre navigateur : seul le donneur d'ordre peut l'ouvrir, pas les autres prestataires ni l'hébergeur. La grille ci-dessus est jointe automatiquement.</p>
      <label class="drop" id="dv-drop"><input type="file" id="dv-file" accept="${Object.keys(TYPES).join(",")}">
        <span id="dv-file-label">Choisir un fichier ou le déposer ici</span></label>
      <div class="dl-row"><button class="btn primary" id="dv-send" disabled>Envoyer le devis</button></div>
      <div id="dv-send-msg" class="small" role="status" aria-live="polite"></div>
      <progress id="dv-prog" max="1" value="0" hidden></progress>` : `
      <p class="small muted">Le dépôt en ligne n'est pas encore ouvert : enregistrez la grille en PDF ou en .json et envoyez-la par e-mail avec votre devis.</p>`}
    </section>

    <details class="more"><summary>Hypothèses des temps estimés</summary>
      <ul class="small">${D.hypotheses.map((h) => `<li>${esc(h)}</li>`).join("")}</ul></details>
    <p class="small muted">Ce document ne quitte pas votre navigateur : enregistrez-le en PDF ou en .json et renvoyez-le par e-mail.</p>
  </div>`;

  const sum = (pred) => Object.entries(S.prix).filter(([k]) => pred(k)).reduce((a, [, v]) => a + num(v), 0);
  const cncTotal = (v) => sum((k) => k.startsWith("mat|") || k.startsWith("glob|") || k.startsWith(`cnc|`) && k.endsWith("|" + v));
  const ebTotal = () => sum((k) => k.startsWith("eb|") || k.startsWith("ebt|"));
  const show = (r) => ({ cnc: r !== "eb", eb: r !== "cnc" });

  function refresh() {
    const sh = show(S.role);
    root.querySelectorAll("[data-sec]").forEach((el) => (el.style.display = sh[el.dataset.sec] ? "" : "none"));
    root.querySelectorAll("#dv-role button").forEach((b) => b.classList.toggle("on", b.dataset.q === S.role));
    const tva = num(S.cond.tva) / 100;
    for (const v of fins) root.querySelector(`[data-tot="cnc|${v}"]`).textContent = euro(cncTotal(v));
    root.querySelector('[data-tot="eb"]').textContent = euro(ebTotal());
    const rows = fins.map((v) => {
      const ht = (sh.cnc ? cncTotal(v) : 0) + (sh.eb ? ebTotal() : 0);
      return `<tr><td><b>Option ${esc(IDX.variantes[v].nom)}</b><br><span class="muted small">${esc(IDX.variantes[v].resume || "")}</span></td>
        <td class="num">${euro(ht)}</td><td class="num">${euro(ht * tva)}</td><td class="num"><b>${euro(ht * (1 + tva))}</b></td></tr>`;
    }).join("");
    root.querySelector("#dv-recap").innerHTML = `<tr><th>Option</th><th class="num">Total HT</th><th class="num">TVA ${esc(S.cond.tva)} %</th><th class="num">Total TTC</th></tr>${rows}`;
  }

  root.addEventListener("input", (ev) => {
    const t = ev.target;
    if (t.dataset.p !== undefined) S.prix[t.dataset.p] = t.value;
    else if (t.dataset.id !== undefined) S.id[t.dataset.id] = t.value;
    else if (t.dataset.c !== undefined) S.cond[t.dataset.c] = t.value;
    else if (t.dataset.inc !== undefined) S.cond.inclus[t.dataset.inc] = t.checked;
    persist(); refresh();
  });
  root.querySelectorAll("#dv-role button").forEach((b) => (b.onclick = () => { S.role = b.dataset.q; persist(); refresh(); }));
  root.querySelector("#dv-pdf").onclick = () => window.print();
  root.querySelector("#dv-reset").onclick = () => {
    if (!confirm("Effacer toute la saisie de ce devis ?")) return;
    try { localStorage.removeItem(KEY); } catch (e) { /* rien */ }
    location.reload();
  };
  const grille = () => {
    const sh = show(S.role), tva = num(S.cond.tva) / 100;
    return {
      reference: "SAS-" + IDX.genere, fichiers_du: IDX.genere, prestataire: S.id, perimetre: S.role, conditions: S.cond,
      cnc: sh.cnc ? {
        panneaux: D.cnc[fins[0]].lignes.map((l) => ({ id: l.id, nom: l.nom, matiere_ht: P("mat|" + l.id),
          usinage_ht: Object.fromEntries(fins.map((v) => [v, P("cnc|" + l.id + "|" + v)])),
          temps_estime_min: Object.fromEntries(fins.map((v) => [v, D.cnc[v].lignes.find((x) => x.id === l.id).temps_total_min])) })),
        communs_ht: Object.fromEntries(GLOBAL_CNC.map(([id]) => [id, P("glob|" + id)])),
        total_ht: Object.fromEntries(fins.map((v) => [v, cncTotal(v)])),
      } : null,
      ebenisterie: sh.eb ? {
        pieces_ht: Object.fromEntries(D.eb.debit.map((x) => [x.id, P("eb|" + x.id)])),
        taches_ht: Object.fromEntries(D.eb.taches.map((t) => [t.id, P("ebt|" + t.id)])), total_ht: ebTotal(),
      } : null,
      options: Object.fromEntries(fins.map((v) => {
        const ht = (sh.cnc ? cncTotal(v) : 0) + (sh.eb ? ebTotal() : 0);
        return [v, { total_ht: ht, tva: ht * tva, total_ttc: ht * (1 + tva) }];
      })),
    };
  };
  root.querySelector("#dv-json").onclick = () =>
    save(new Blob([JSON.stringify(grille(), null, 2)], { type: "application/json" }), `devis_${IDX.genere}_${(S.id.societe || "prestataire").replace(/\W+/g, "_")}.json`);
  root.querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => actions[b.dataset.act] && actions[b.dataset.act]()));
  if (IDX.depot && IDX.depot.url) depotUi(root, IDX, S, grille);
  refresh();
}

// ------------------------------------------------------------------ envoi du devis
function depotUi(root, IDX, S, grille) {
  const input = root.querySelector("#dv-file"), send = root.querySelector("#dv-send");
  const msg = root.querySelector("#dv-send-msg"), prog = root.querySelector("#dv-prog");
  const label = root.querySelector("#dv-file-label"), drop = root.querySelector("#dv-drop");
  let file = null;
  const say = (t, cls = "") => { msg.className = "small " + cls; msg.textContent = t; };
  const pick = (f) => {
    file = null; send.disabled = true;
    if (!f) return;
    const ext = extOf(f.name);
    if (!TYPES[ext]) return say(`Format refusé (${ext || "sans extension"}) : PDF, Excel, Word ou image.`, "bad");
    if (f.size > MAX_OCTETS) return say(`Fichier trop gros (${nf(f.size / 1048576)} Mo) : 20 Mo au plus.`, "bad");
    file = f;
    label.textContent = `${f.name} · ${nf(f.size / 1048576, 2)} Mo`;
    send.disabled = false;
    say("");
  };
  input.onchange = () => pick(input.files[0]);
  drop.ondragover = (ev) => { ev.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (ev) => { ev.preventDefault(); drop.classList.remove("over"); pick(ev.dataTransfer.files[0]); };
  send.onclick = async () => {
    if (!file) return;
    if (!(S.id.societe || "").trim() || !(S.id.email || "").trim()) return say("Indiquez au moins la société et l'e-mail (section Prestataire).", "bad");
    send.disabled = true;
    try {
      say("Chiffrement…");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const header = {
        version: 1, metier: S.role, prestataire: S.id, fichier: file.name, type: TYPES[extOf(file.name)],
        octets: bytes.length, sha256: await sha256hex(bytes), date: new Date().toISOString(),
        sas_genere: IDX.genere, grille: grille(),
      };
      const pkg = await seal(await importPublicKey(IDX.depot.cle), header, bytes);
      say("Envoi…");
      prog.hidden = false;
      const res = await new Promise((ok, ko) => {
        const x = new XMLHttpRequest();
        x.open("POST", IDX.depot.url.replace(/\/$/, "") + "/depot");
        x.upload.onprogress = (e) => { if (e.lengthComputable) prog.value = e.loaded / e.total; };
        x.onload = () => { try { ok({ status: x.status, body: JSON.parse(x.responseText) }); } catch (e) { ko(new Error("réponse illisible")); } };
        x.onerror = () => ko(new Error("connexion impossible"));
        x.timeout = 15 * 60 * 1000;
        x.ontimeout = () => ko(new Error("délai dépassé"));
        x.send(pkg);
      });
      if (res.status !== 200 || !res.body.ok) throw new Error(res.body.erreur || "refusé (" + res.status + ")");
      say(`Devis reçu, merci. Numéro de dépôt : ${res.body.numero} (empreinte ${header.sha256.slice(0, 12)}). Conservez-le.`, "ok");
    } catch (err) {
      say("Échec de l'envoi : " + err.message + ". Réessayez, ou envoyez le fichier par e-mail.", "bad");
      send.disabled = false;
    } finally {
      prog.hidden = true;
    }
  };
}
