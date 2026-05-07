import type { ServerRow } from "../drivers/types.js";
import { decryptSecret } from "../crypto.js";
import { getEncryptionMaster } from "../cryptoEnv.js";
import type { SshAuth } from "./client.js";

/** Собирает опции для ssh2: ключ OpenSSH/RSA PEM и/или пароль (PuTTY .ppk не поддерживается). */
export function buildSshAuthFromServer(server: ServerRow): SshAuth {
  const master = getEncryptionMaster();
  const pk = decryptSecret(server.ssh_private_key_enc, master).trim();
  const pwdEnc = server.ssh_password_enc;
  const pwd =
    pwdEnc != null && String(pwdEnc).length > 0 ? decryptSecret(String(pwdEnc), master).trim() : "";
  const privateKey = pk.length > 0 ? pk : undefined;
  const password = pwd.length > 0 ? pwd : undefined;
  if (!privateKey && !password) {
    throw new Error("SSH key or password missing for server");
  }
  /** Пароль имеет приоритет: иначе мусор в поле ключа ломает parse при наличии корректного пароля. */
  if (password) {
    return { host: server.ssh_host, port: server.ssh_port, username: server.ssh_user, password };
  }
  return {
    host: server.ssh_host,
    port: server.ssh_port,
    username: server.ssh_user,
    privateKey,
  };
}
