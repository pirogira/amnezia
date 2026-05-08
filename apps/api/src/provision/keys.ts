import { randomInt } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519.js";

/**
 * Обфускация в духе Amnezia (Jmin 40–89, S1/S2, разные H1–H4; S1+56≠S2).
 * Поля S3/S4 из AWG 2.0 в конфиг не пишем: в образе amneziavpn/amnezia-wg `wg-quick` вызывает
 * обычный `wg setconf`, он не понимает `S3`/`S4` → «Line unrecognized».
 * Десятичные uint32 для H* (не hex).
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

/** Случайные параметры AmneziaWG для .conf (совместимо с `wg setconf` в Docker-образе). */
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
  const [h1, h2, h3, h4] = fourDistinctMagicHeaders();
  return {
    Jc: jc,
    Jmin: jmin,
    Jmax: jmax,
    S1: String(s1N),
    S2: String(s2N),
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
