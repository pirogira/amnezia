import { randomBytes, randomInt } from "node:crypto";
import { x25519 } from "@noble/curves/ed25519.js";

function randHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** Случайные параметры AmneziaWG в формате строк для .conf (как у типичного клиента Amnezia). */
export function generateAwgObfuscationParams(): Record<string, string> {
  const jc = String(randomInt(3, 6));
  const jminN = randomInt(10, 35);
  const jmin = String(jminN);
  const jmax = String(randomInt(Math.max(50, jminN + 15), 130));
  const s1 = String(randomInt(0, 256));
  const s2 = String(randomInt(0, 256));
  const h1 = randHex(8);
  const h2 = randHex(8);
  const h3 = randHex(8);
  const h4 = randHex(8);
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
