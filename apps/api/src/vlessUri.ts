/** Параметры Reality для экспорта URI (как в v2rayN / Happ и т.п.). */
export type VlessRealityParams = {
  pbk: string;
  sni: string;
  sid: string;
  fp?: string;
  spx?: string;
  type?: string;
  encryption?: string;
  security?: string;
  flow?: string;
};

export function parseVlessRealityJson(raw: string | null | undefined): VlessRealityParams | null {
  if (raw == null || !String(raw).trim()) return null;
  try {
    const o = JSON.parse(String(raw)) as Record<string, unknown>;
    const pbk = typeof o.pbk === "string" ? o.pbk.trim() : "";
    const sni = typeof o.sni === "string" ? o.sni.trim() : "";
    const sid = typeof o.sid === "string" ? o.sid.trim() : "";
    if (!pbk || !sni || !sid) return null;
    const pick = (k: string): string | undefined => {
      const v = o[k];
      return typeof v === "string" && v.length > 0 ? v : undefined;
    };
    return {
      pbk,
      sni,
      sid,
      fp: pick("fp"),
      spx: pick("spx"),
      type: pick("type"),
      encryption: pick("encryption"),
      security: pick("security"),
      flow: pick("flow"),
    };
  } catch {
    return null;
  }
}

/**
 * Собирает vless://… с query как в типичных клиентах.
 * UUID — id пользователя на стороне Xray; панель его генерирует — inbound на сервере нужно обновить вручную или скриптом.
 */
export function buildVlessRealityUri(params: {
  uuid: string;
  address: string;
  port: number;
  name: string;
  reality: VlessRealityParams;
}): string {
  const { uuid, address, port, name, reality } = params;
  const q = new URLSearchParams();
  q.set("type", reality.type ?? "tcp");
  q.set("encryption", reality.encryption ?? "none");
  q.set("security", reality.security ?? "reality");
  q.set("pbk", reality.pbk);
  q.set("fp", reality.fp ?? "chrome");
  q.set("sni", reality.sni);
  q.set("sid", reality.sid);
  const spx = reality.spx ?? "/";
  q.set("spx", spx);
  if (reality.flow) q.set("flow", reality.flow);
  const frag = encodeURIComponent(name);
  return `vless://${uuid}@${address}:${port}?${q.toString()}#${frag}`;
}
