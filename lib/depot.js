// Depot d'un devis : le fichier est chiffre pour le seul destinataire (cle publique RSA-OAEP),
// le service de stockage et les autres prestataires ne voient que des octets illisibles.
// Format : "SASD1" | u16 longueur cle enveloppee | cle AES enveloppee (RSA-OAEP-SHA256) | iv (12) |
//          AES-GCM( u32 longueur en-tete | en-tete JSON | fichier ).
// Dechiffre par sas.py (--recevoir) : tout changement ici doit y etre reporte (test_sas.py le verifie).

export const MAGIC = new TextEncoder().encode("SASD1");
export const MAX_OCTETS = 20 * 1024 * 1024;
export const TYPES = {
  ".pdf": "application/pdf",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

export function extOf(name) {
  const m = /\.[a-z0-9]+$/i.exec(name || "");
  return m ? m[0].toLowerCase() : "";
}

export async function importPublicKey(jwk) {
  return crypto.subtle.importKey("jwk", jwk, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
}

export async function seal(pub, header, fileBytes) {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const clear = new Uint8Array(4 + h.length + fileBytes.length);
  new DataView(clear.buffer).setUint32(0, h.length, true);
  clear.set(h, 4);
  clear.set(fileBytes, 4 + h.length);
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", aes));
  const wrapped = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, pub, raw));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, clear));
  const out = new Uint8Array(MAGIC.length + 2 + wrapped.length + 12 + ct.length);
  let o = 0;
  out.set(MAGIC, o); o += MAGIC.length;
  new DataView(out.buffer).setUint16(o, wrapped.length, true); o += 2;
  out.set(wrapped, o); o += wrapped.length;
  out.set(iv, o); o += 12;
  out.set(ct, o);
  return out;
}

export async function sha256hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}
