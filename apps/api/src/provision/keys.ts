import { randomInt } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519.js";

/**
 * Параметры обфускации AmneziaWG 2.0 для серверного .conf:
 * — S3/S4 (cookie / transport padding);
 * — H1–H4 — разные десятичные uint32 (как раньше); при необходимости диапазоны `a-b` поддерживает amneziawg-go.
 */
const H_MAGIC_MIN = 100_000;
const H_MAGIC_MAX_EXCLUSIVE = 2_000_000_001;

function fourDistinctMagicHeaders(): [string, string, string, string] {
  const seen = new Set<number>();
  while (seen.size < 4) {
    seen.add(randomInt(H_MAGIC_MIN, H_MAGIC_MAX_EXCLUSIVE));
  }
  const arr = [...seen];
  return [String(arr[0]), String(arr[1]), String(arr[2]), String(arr[3])];
}

/** Случайные параметры AmneziaWG 2.0 для .conf (awg-quick + amneziawg-go из образа провижининга). */
export function generateAwgObfuscationParams(): Record<string, string> {
  const jc = String(randomInt(3, 7));
  const jminN = randomInt(40, 90);
  const jmin = String(jminN);
  const jmax = String(randomInt(jminN + 50, jminN + 251));
  let s1N = randomInt(15, 151);
  let s2N = randomInt(15, 151);
  if (s1N + 56 === s2N) {
    s2N = s1N + 57 <= 150 ? s1N + 57 : s1N - 1;
    if (s2N < 15) s2N = 15;
  }
  const s3N = randomInt(15, 151);
  const s4N = randomInt(15, 151);
  const [h1, h2, h3, h4] = fourDistinctMagicHeaders();
  return {
    Jc: jc,
    Jmin: jmin,
    Jmax: jmax,
    S1: String(s1N),
    S2: String(s2N),
    S3: String(s3N),
    S4: String(s4N),
    H1: h1,
    H2: h2,
    H3: h3,
    H4: h4,
  };
}

/** Ключи WireGuard (Curve25519), base64 как в `wg genkey` / `wg pubkey`. */
export function generateWgServerKeypair(): { privateKey: string; publicKey: string } {
  const { secretKey, publicKey } = x25519.keygen();
  return {
    privateKey: Buffer.from(secretKey).toString("base64"),
    publicKey: Buffer.from(publicKey).toString("base64"),
  };
}
