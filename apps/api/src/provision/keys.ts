import { randomInt } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519.js";

/** Magic header H1–H4: десятичные uint32, как в Amnezia / `wg setconf` (hex-строка даёт Unable to parse H1). */
function randMagicHeader(): string {
  return String(randomInt(10_000, 4_000_000_000));
}

/** Случайные параметры AmneziaWG в формате строк для .conf (как у типичного клиента Amnezia). */
export function generateAwgObfuscationParams(): Record<string, string> {
  const jc = String(randomInt(3, 6));
  const jminN = randomInt(10, 35);
  const jmin = String(jminN);
  const jmax = String(randomInt(Math.max(50, jminN + 15), 130));
  const s1 = String(randomInt(0, 256));
  const s2 = String(randomInt(0, 256));
  const h1 = randMagicHeader();
  const h2 = randMagicHeader();
  const h3 = randMagicHeader();
  const h4 = randMagicHeader();
  return {
    Jc: jc,
    Jmin: jmin,
    Jmax: jmax,
    S1: s1,
    S2: s2,
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
