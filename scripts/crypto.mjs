/*
 * 대시보드 데이터 암호화 (AES-256-GCM, 키 유도: PBKDF2-SHA256)
 * 브라우저(docs/index.html)의 복호화 로직과 형식이 같아야 합니다.
 *
 *  docs/data/meta.json      { v, kdf, iter, salt, check }  ← 비밀번호 검증용 (데이터 없음)
 *  docs/data/*.enc.json     { v, iv, ct }                   ← 암호화된 집계 데이터
 */
const { subtle } = globalThis.crypto;
export const ITERATIONS = 600000;

export const b64 = (buf) => Buffer.from(buf).toString('base64');
export const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export async function deriveKey(password, salt, iter = ITERATIONS) {
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptJson(key, obj) {
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  return { v: 1, iv: b64(iv), ct: b64(ct) };
}

export async function decryptJson(key, box) {
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(box.iv) }, key, unb64(box.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/** meta.json 생성 (새 salt) */
export async function createMeta(password) {
  const salt = rand(16);
  const key = await deriveKey(password, salt);
  const check = await encryptJson(key, { ok: true });
  return { meta: { v: 1, kdf: 'PBKDF2-SHA256', iter: ITERATIONS, salt: b64(salt), check }, key };
}

/** 기존 meta.json으로 키 유도 + 비밀번호 검증 */
export async function openMeta(meta, password) {
  const key = await deriveKey(password, unb64(meta.salt), meta.iter);
  try { await decryptJson(key, meta.check); } catch { throw new Error('DASHBOARD_PASSWORD가 기존 암호화 비밀번호와 다릅니다. (변경하려면 scripts/rekey.mjs 사용)'); }
  return key;
}
