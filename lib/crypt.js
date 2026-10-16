// AES-GCM 256 : fichier publie = IV (12 octets) + texte chiffre + etiquette.
// La cle n'est jamais publiee : elle voyage dans le lien, apres le # (jamais envoye au serveur).
const subtle = globalThis.crypto.subtle;

export function b64urlToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importKey(b64url) {
  return subtle.importKey("raw", b64urlToBytes(b64url), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encrypt(key, data) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, data));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

export async function decrypt(key, data) {
  const b = new Uint8Array(data);
  return subtle.decrypt({ name: "AES-GCM", iv: b.subarray(0, 12) }, key, b.subarray(12));
}

// nom publie d'un fichier : empreinte du nom + cle, pour ne rien laisser lire dans le depot
export async function opaqueName(keyB64, name) {
  const h = await subtle.digest("SHA-256", new TextEncoder().encode(keyB64 + "/" + name));
  return Array.from(new Uint8Array(h).subarray(0, 12), (x) => x.toString(16).padStart(2, "0")).join("") + ".bin";
}
