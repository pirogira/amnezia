import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { VpnProtocol } from "@amnesia-veb/shared";
import { api, getToken, setToken } from "./api.js";

type Me = { id: string; username: string; created_at: string };
type VlessReality = {
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

type Server = {
  id: string;
  name: string;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  dockerWgContainer: string;
  wgInterface: string;
  vpnSubnetCidr: string;
  endpointHost: string;
  listenPort: number;
  driverMode: string;
  dockerComposePath: string | null;
  portChangeHookCmd: string | null;
  vlessReality?: VlessReality | null;
};
type ClientRow = {
  id: string;
  name: string;
  protocol: string;
  public_key: string;
  assigned_ip: string;
  listen_port: number;
  revoked_at: string | null;
  created_at: string;
};

export function App() {
  const [token, setTok] = useState<string | null>(() => getToken());
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [servers, setServers] = useState<Server[]>([]);
  const [activeServerId, setActiveServerId] = useState<string | null>(null);
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [lastConf, setLastConf] = useState<string | null>(null);
  const [lastVpnUri, setLastVpnUri] = useState<string | null>(null);

  const activeServer = useMemo(
    () => servers.find((s) => s.id === activeServerId) ?? null,
    [servers, activeServerId],
  );

  useEffect(() => {
    if (!token) {
      setMe(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const m = await api<Me>("/api/me");
        if (!cancelled) setMe(m);
      } catch {
        if (!cancelled) {
          setToken(null);
          setTok(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await api<Server[]>("/api/servers");
        if (!cancelled) {
          setServers(list);
          setActiveServerId((prev) =>
            prev && list.some((s) => s.id === prev) ? prev : (list[0]?.id ?? null),
          );
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    if (!token || !activeServerId) {
      setClients([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await api<ClientRow[]>(`/api/servers/${activeServerId}/clients`);
        if (!cancelled) setClients(list);
      } catch {
        if (!cancelled) setClients([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, activeServerId]);

  async function login(username: string, password: string) {
    setErr(null);
    const r = await api<{ token: string }>("/api/auth/login", {
      method: "POST",
      json: { username, password },
    });
    setToken(r.token);
    setTok(r.token);
  }

  async function logout() {
    setToken(null);
    setTok(null);
    setMe(null);
    setServers([]);
    setClients([]);
    setLastConf(null);
  }

  if (!token || !me) {
    return (
      <div className="layout">
        <h1 className="h1">Amnezia panel</h1>
        <p className="muted">Вход администратора</p>
        <LoginPortWarning />
        <LoginForm onLogin={login} error={err} setError={setErr} />
      </div>
    );
  }

  return (
    <div className="layout">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: "1rem" }}>
        <div>
          <h1 className="h1">Amnezia panel</h1>
          <p className="muted">
            {me.username} · <button className="btn" type="button" onClick={() => void logout()}>Выйти</button>
          </p>
        </div>
      </div>

      <div className="card">
        <h2 className="h2">Серверы</h2>
        <ServerForm
          onCreated={async () => {
            const list = await api<Server[]>("/api/servers");
            setServers(list);
            setActiveServerId((prev) =>
              prev && list.some((s) => s.id === prev) ? prev : (list[0]?.id ?? null),
            );
          }}
        />
        <div style={{ marginTop: "0.75rem" }}>
          <label className="muted">Активный сервер: </label>
          <select
            value={activeServerId ?? ""}
            onChange={(e) => setActiveServerId(e.target.value || null)}
            disabled={servers.length === 0}
          >
            {servers.length === 0 ? (
              <option value="">— добавьте сервер выше —</option>
            ) : (
              servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.driverMode})
                </option>
              ))
            )}
          </select>
        </div>
      </div>

      {activeServer && (
        <div className="card">
          <h2 className="h2">Клиенты · {activeServer.name}</h2>
          <ClientForm
            server={activeServer}
            onCreated={async (conf, vpnUri) => {
              setLastConf(conf);
              setLastVpnUri(vpnUri ?? null);
              const list = await api<ClientRow[]>(`/api/servers/${activeServer.id}/clients`);
              setClients(list);
            }}
          />
          {lastConf && (
            <div style={{ marginTop: "1rem" }}>
              <p className="muted">Последний созданный конфиг (.conf)</p>
              <div className="qr">
                <QRCodeSVG value={lastConf} size={180} />
              </div>
              <pre style={{ whiteSpace: "pre-wrap", fontSize: "0.75rem" }}>{lastConf}</pre>
              {lastVpnUri && (
                <div style={{ marginTop: "1rem" }}>
                  <p className="muted">Импорт в приложение Amnezia (ссылка vpn://)</p>
                  <div className="qr">
                    <QRCodeSVG value={lastVpnUri} size={180} />
                  </div>
                  <textarea
                    readOnly
                    rows={4}
                    value={lastVpnUri}
                    style={{ width: "100%", fontFamily: "monospace", fontSize: "0.7rem" }}
                  />
                  <button
                    className="btn"
                    type="button"
                    style={{ marginTop: "0.35rem" }}
                    onClick={() => void navigator.clipboard.writeText(lastVpnUri)}
                  >
                    Копировать vpn://
                  </button>
                </div>
              )}
            </div>
          )}
          <table className="table" style={{ marginTop: "1rem" }}>
            <thead>
              <tr>
                <th>Имя</th>
                <th>Протокол</th>
                <th>IP</th>
                <th>Порт</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.protocol}</td>
                  <td>{c.assigned_ip}</td>
                  <td>{c.listen_port}</td>
                  <td>{c.revoked_at ? "отозван" : "активен"}</td>
                  <td>
                    <button
                      className="btn"
                      type="button"
                      onClick={async () => {
                        const text = await api<string>(`/api/clients/${c.id}/wg.conf`);
                        const blob = new Blob([text], { type: "text/plain" });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement("a");
                        a.href = url;
                        a.download = c.protocol === "vless" ? `${c.name}.txt` : `${c.name}.conf`;
                        a.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      {c.protocol === "vless" ? "ссылка" : ".conf"}
                    </button>
                    {c.protocol === "amneziawg" && (
                      <>
                        {" "}
                        <button
                          className="btn"
                          type="button"
                          onClick={async () => {
                            const { vpnUri } = await api<{ vpnUri: string }>(`/api/clients/${c.id}/vpn`);
                            const blob = new Blob([vpnUri], { type: "text/plain" });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement("a");
                            a.href = url;
                            a.download = `${c.name}-amnezia.txt`;
                            a.click();
                            URL.revokeObjectURL(url);
                          }}
                        >
                          vpn://
                        </button>
                      </>
                    )}{" "}
                    {!c.revoked_at && (
                      <button
                        className="btn danger"
                        type="button"
                        onClick={async () => {
                          await api(`/api/clients/${c.id}`, { method: "DELETE" });
                          const list = await api<ClientRow[]>(
                            `/api/servers/${activeServer.id}/clients`,
                          );
                          setClients(list);
                        }}
                      >
                        Отозвать
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {activeServer && (
        <div className="card">
          <h2 className="h2">Порт и префлайт</h2>
          <PortForm serverId={activeServer.id} currentPort={activeServer.listenPort} />
        </div>
      )}
    </div>
  );
}

type LoginInfo = {
  defaultUsername: string;
  hasAdmins: boolean;
  devPassword: string | null;
  helpRu: string;
};

/** Порт 5173 — это Vite (dev). На VPS панель из Docker обычно на 8443 (HTTPS) или 8080 (HTTP). */
function LoginPortWarning() {
  if (typeof window === "undefined") return null;
  const { port, hostname } = window.location;
  if (port !== "5173") return null;
  if (hostname === "localhost" || hostname === "127.0.0.1") return null;
  const https8443 = `https://${hostname}:8443/`;
  const http8080 = `http://${hostname}:8080/`;
  return (
    <div
      className="card"
      style={{
        marginBottom: "1rem",
        borderColor: "#b45309",
        background: "#1a1410",
      }}
    >
      <p className="error" style={{ margin: "0 0 0.5rem" }}>
        Вы открыли порт <strong>5173</strong> — это режим <strong>разработки (Vite)</strong>, а не панель из Docker на
        сервере.
      </p>
      <p className="muted" style={{ margin: "0 0 0.5rem", fontSize: "0.9rem" }}>
        Пароль из установки подходит к панели на порту из <code>install.sh</code> (часто <strong>8443</strong> HTTPS
        или <strong>8080</strong> HTTP). Смотрите файл <code>panel-credentials.txt</code> на VPS — там точный URL.
      </p>
      <p style={{ margin: 0, fontSize: "0.9rem" }}>
        Попробуйте:{" "}
        <a href={https8443}>{https8443}</a> или <a href={http8080}>{http8080}</a>
      </p>
    </div>
  );
}

function LoginForm(props: {
  onLogin: (u: string, p: string) => Promise<void>;
  error: string | null;
  setError: (e: string | null) => void;
}) {
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [info, setInfo] = useState<LoginInfo | null>(null);
  const [infoHint, setInfoHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      for (let i = 0; i < 50; i++) {
        if (cancelled) return;
        try {
          const j = await api<LoginInfo>("/api/auth/login-info");
          if (!cancelled) {
            setInfo(j);
            setUsername(j.defaultUsername || "admin");
            if (j.devPassword) setPassword(j.devPassword);
            setInfoHint(null);
          }
          return;
        } catch {
          if (i === 0) setInfoHint("Ждём API… обновите страницу, если так висит долго.");
          await sleep(300);
        }
      }
      if (!cancelled) setInfoHint("Не удалось связаться с API. Убедитесь, что `npm run dev` запущен и порт 3001 свободен.");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await props.onLogin(username, password);
        } catch (er) {
          props.setError(er instanceof Error ? er.message : "Ошибка входа");
        }
      }}
    >
      {infoHint && !info && <p className="muted">{infoHint}</p>}
      {info && (
        <div className="muted" style={{ marginBottom: "1rem", fontSize: "0.88rem" }}>
          <p style={{ margin: "0 0 0.5rem" }}>{info.helpRu}</p>
          {!info.hasAdmins && (
            <p className="error" style={{ margin: 0 }}>
              В базе ещё нет администратора — задайте PANEL_BOOTSTRAP_PASSWORD в .env и перезапустите API (или npm run
              db:reset).
            </p>
          )}
          {info.devPassword && (
            <p style={{ margin: "0.5rem 0 0", color: "#fbbf24" }}>
              Режим отладки: пароль из .env подставлен в поле ниже (PANEL_SHOW_LOGIN_PASSWORD=true). Отключите в
              production.
            </p>
          )}
        </div>
      )}
      <div className="row">
        <div className="field">
          <label>Логин</label>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
        </div>
        <div className="field">
          <label>Пароль</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        <button className="btn primary" type="submit">
          Войти
        </button>
      </div>
      {props.error && <p className="error">{props.error}</p>}
    </form>
  );
}

function ServerForm(props: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("My VPS");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState(22);
  const [sshUser, setSshUser] = useState("root");
  const [sshKey, setSshKey] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const [container, setContainer] = useState("amnezia-awg");
  const [wgInterface, setWgInterface] = useState("wg0");
  const [cidr, setCidr] = useState("10.8.0.0/24");
  const [endpoint, setEndpoint] = useState("");
  const [listenPort, setListenPort] = useState(51820);
  const [driverMode, setDriverMode] = useState<"ssh" | "mock">("mock");
  const [composePath, setComposePath] = useState("");
  const [hook, setHook] = useState("");
  const [vlessJson, setVlessJson] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        setMsg(null);
        let vlessReality: VlessReality | undefined;
        if (vlessJson.trim()) {
          try {
            vlessReality = JSON.parse(vlessJson) as VlessReality;
          } catch {
            setMsg("Невалидный JSON в поле VLESS Reality");
            return;
          }
        }
        try {
          await api("/api/servers", {
            method: "POST",
            json: {
              name,
              sshHost,
              sshPort,
              sshUser,
              sshPrivateKey: sshKey,
              sshPassword,
              dockerWgContainer: container,
            wgInterface,
            vpnSubnetCidr: cidr,
            endpointHost: endpoint || sshHost,
            listenPort,
            driverMode,
            dockerComposePath: composePath || null,
            portChangeHookCmd: hook || null,
            vlessReality,
            },
          });
          setMsg("Сервер добавлен");
          await props.onCreated();
        } catch (e) {
          setMsg(e instanceof Error ? e.message : String(e));
        }
      }}
    >
      <div className="field">
        <label>Имя</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>SSH host</label>
        <input value={sshHost} onChange={(e) => setSshHost(e.target.value)} required />
      </div>
      <div className="field">
        <label>SSH port</label>
        <input
          type="number"
          value={sshPort}
          onChange={(e) => setSshPort(Number(e.target.value))}
        />
      </div>
      <div className="field">
        <label>SSH user</label>
        <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} />
      </div>
      <div className="field" style={{ flex: "1 1 240px" }}>
        <label>SSH private key (OpenSSH / RSA PEM)</label>
        <textarea
          value={sshKey}
          onChange={(e) => setSshKey(e.target.value)}
          placeholder="-----BEGIN OPENSSH PRIVATE KEY----- … или оставьте пустым, если ниже пароль"
          rows={6}
        />
        <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.8rem" }}>
          PuTTY .ppk сюда не подходит — конвертация: <code>puttygen key.ppk -O private-openssh -o key.pem</code>
        </p>
      </div>
      <div className="field">
        <label>SSH пароль (если без ключа)</label>
        <input
          type="password"
          autoComplete="new-password"
          value={sshPassword}
          onChange={(e) => setSshPassword(e.target.value)}
          placeholder="пароль пользователя SSH — не пароль панели"
        />
      </div>
      <div className="field">
        <label>Docker контейнер WG</label>
        <input value={container} onChange={(e) => setContainer(e.target.value)} />
      </div>
      <div className="field">
        <label>Интерфейс (wg0 или awg0)</label>
        <input value={wgInterface} onChange={(e) => setWgInterface(e.target.value)} />
        <p className="muted" style={{ margin: "0.25rem 0 0", fontSize: "0.8rem" }}>
          AmneziaWG / awg2: часто <code>awg0</code>. Проверка: <code>docker exec ИМЯ_КОНТЕЙНЕРА wg show</code>
        </p>
      </div>
      <div className="field">
        <label>VPN subnet /24</label>
        <input value={cidr} onChange={(e) => setCidr(e.target.value)} />
      </div>
      <div className="field">
        <label>Endpoint host</label>
        <input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="публичный IP/DNS" />
      </div>
      <div className="field">
        <label>Listen port (клиент)</label>
        <input
          type="number"
          value={listenPort}
          onChange={(e) => setListenPort(Number(e.target.value))}
        />
      </div>
      <div className="field">
        <label>Режим драйвера</label>
        <select value={driverMode} onChange={(e) => setDriverMode(e.target.value as "ssh" | "mock")}>
          <option value="mock">mock (без SSH)</option>
          <option value="ssh">ssh (реальный VPS)</option>
        </select>
      </div>
      <div className="field" style={{ flex: "1 1 220px" }}>
        <label>docker compose path (префлайт)</label>
        <input
          value={composePath}
          onChange={(e) => setComposePath(e.target.value)}
          placeholder="/opt/amnezia/docker-compose.yml"
        />
      </div>
      <div className="field" style={{ flex: "1 1 220px" }}>
        <label>Hook смены порта на VPS</label>
        <input
          value={hook}
          onChange={(e) => setHook(e.target.value)}
          placeholder="/opt/amnesia/set-port.sh"
        />
      </div>
      <div className="field" style={{ flex: "1 1 100%" }}>
        <label>VLESS Reality (JSON, опционально)</label>
        <textarea
          value={vlessJson}
          onChange={(e) => setVlessJson(e.target.value)}
          rows={5}
          placeholder={`{\n  "pbk": "…публичный ключ Reality…",\n  "sni": "aws.amazon.com",\n  "sid": "8b",\n  "fp": "chrome",\n  "spx": "/",\n  "type": "tcp",\n  "encryption": "none",\n  "security": "reality"\n}`}
          style={{ fontFamily: "monospace", fontSize: "0.85rem" }}
        />
        <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.8rem" }}>
          Нужно для протокола «VLESS» в выдаче клиента: ссылка vless:// строится из endpoint + порта сервера и этих полей. Панель пока не правит Xray на VPS — UUID в ссылке нужно вручную добавить в inbound (или позже через скрипт).
        </p>
      </div>
      <button className="btn primary" type="submit">
        Добавить сервер
      </button>
      {msg && (
        <p className={msg === "Сервер добавлен" ? "muted" : "error"} style={{ width: "100%", marginTop: "0.5rem" }}>
          {msg}
        </p>
      )}
    </form>
  );
}

function ClientForm(props: {
  server: Server;
  onCreated: (conf: string, vpnUri?: string) => Promise<void>;
}) {
  const [name, setName] = useState("user1");
  const [protocol, setProtocol] = useState<VpnProtocol>("amneziawg");
  const [listenPort, setListenPort] = useState(props.server.listenPort);
  const [dns, setDns] = useState("1.1.1.1");
  const [junkCount, setJunkCount] = useState<number | "">("");
  const [routeIpv6, setRouteIpv6] = useState(false);
  const [mtu, setMtu] = useState<number | "">("");
  const [expires, setExpires] = useState("");
  const [clientErr, setClientErr] = useState<string | null>(null);
  const [clientBusy, setClientBusy] = useState(false);

  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        setClientErr(null);
        setClientBusy(true);
        try {
          const security: Record<string, unknown> = {};
          if (dns) security.dns = dns;
          if (junkCount !== "") security.junkPacketCount = Number(junkCount);
          if (routeIpv6) security.includeIpv6DefaultRoute = true;
          if (mtu !== "") security.mtu = Number(mtu);
          const r = await api<{ clientConf: string; id: string; assignedIp: string; vpnUri?: string }>(
            `/api/servers/${props.server.id}/clients`,
            {
              method: "POST",
              json: {
                name,
                protocol,
                listenPort,
                security,
                expiresAt: expires || null,
              },
            },
          );
          await props.onCreated(r.clientConf, r.vpnUri);
        } catch (err) {
          setClientErr(err instanceof Error ? err.message : String(err));
        } finally {
          setClientBusy(false);
        }
      }}
    >
      <div className="field">
        <label>Имя клиента</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Протокол</label>
        <select value={protocol} onChange={(e) => setProtocol(e.target.value as VpnProtocol)}>
          <option value="amneziawg">AmneziaWG</option>
          <option value="wireguard">WireGuard</option>
          <option value="vless">VLESS + Reality (ссылка vless://)</option>
          <option value="openvpn">OpenVPN (заглушка)</option>
          <option value="cloak">Cloak (заглушка)</option>
        </select>
      </div>
      {protocol === "vless" && !props.server.vlessReality && (
        <p className="error" style={{ width: "100%" }}>
          На этом сервере не задан JSON VLESS Reality. Отредактируйте сервер нельзя в UI — добавьте новый сервер с заполненным блоком «VLESS Reality» или через API.
        </p>
      )}
      {protocol === "vless" && (
        <p className="muted" style={{ width: "100%", fontSize: "0.85rem" }}>
          В ссылке будет новый UUID клиента. Его нужно прописать в Xray (или другом ядре) на VPS в том же inbound, что и остальные клиенты Reality, иначе подключение не примет.
        </p>
      )}
      {protocol === "amneziawg" && (
        <p className="muted" style={{ width: "100%", fontSize: "0.85rem" }}>
          В .conf подставляются параметры AmneziaWG (Jc, Jmin, Jmax, S1–S4, H1–H4, I1–I5) с сервера по выводу <code>wg show</code>. По умолчанию в туннель уходит только IPv4 (<code>0.0.0.0/0</code>) и MTU 1280 — так стабильнее, если на сервере нет IPv6/NAT. После создания также выдаётся <code>vpn://…</code> для приложения Amnezia.
        </p>
      )}
      <div className="field">
        <label>Порт в конфиге</label>
        <input
          type="number"
          value={listenPort}
          onChange={(e) => setListenPort(Number(e.target.value))}
        />
      </div>
      {protocol !== "vless" && (
        <>
          <div className="field">
            <label>DNS</label>
            <input value={dns} onChange={(e) => setDns(e.target.value)} />
          </div>
          <div className="field">
            <label>junk_packet_count (AWG)</label>
            <input
              type="number"
              value={junkCount}
              onChange={(e) => setJunkCount(e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="опционально"
            />
          </div>
          <div className="field" style={{ flex: "1 1 100%", alignItems: "flex-start" }}>
            <label style={{ display: "flex", gap: "0.5rem", alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={routeIpv6} onChange={(e) => setRouteIpv6(e.target.checked)} />
              Маршрут IPv6 (<code>::/0</code>) — только если на сервере настроен IPv6 через VPN
            </label>
          </div>
          <div className="field">
            <label>MTU (опционально)</label>
            <input
              type="number"
              value={mtu}
              onChange={(e) => setMtu(e.target.value === "" ? "" : Number(e.target.value))}
              placeholder="пусто = авто (1280 для AmneziaWG)"
            />
          </div>
        </>
      )}
      <div className="field">
        <label>Истекает (ISO)</label>
        <input value={expires} onChange={(e) => setExpires(e.target.value)} placeholder="2027-01-01T00:00:00.000Z" />
      </div>
      <button className="btn primary" type="submit" disabled={clientBusy}>
        {clientBusy ? "Создание…" : "Выдать клиента"}
      </button>
      {clientErr && <p className="error" style={{ width: "100%", margin: "0.5rem 0 0" }}>{clientErr}</p>}
      <p className="muted" style={{ width: "100%", margin: "0.75rem 0 0", fontSize: "0.85rem" }}>
        {protocol === "vless"
          ? "Для VLESS — одна строка vless://… (и QR с ней), её можно вставить в клиенты с импортом по ссылке."
          : "У WireGuard / AmneziaWG доступ — через файл .conf и QR; для AmneziaWG дополнительно — ссылка vpn:// и QR по ней для приложения Amnezia."}
      </p>
    </form>
  );
}

function PortForm(props: { serverId: string; currentPort: number }) {
  const [port, setPort] = useState(props.currentPort);
  const [result, setResult] = useState<string | null>(null);
  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await api<{ status: string; message?: string; port?: number }>(
          `/api/servers/${props.serverId}/listen-port`,
          { method: "POST", json: { port } },
        );
        setResult(JSON.stringify(r, null, 2));
      }}
    >
      <div className="field">
        <label>Новый listen port</label>
        <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
      </div>
      <button className="btn primary" type="submit">
        Применить (hook / БД)
      </button>
      {result && (
        <pre style={{ width: "100%", whiteSpace: "pre-wrap", fontSize: "0.8rem" }}>{result}</pre>
      )}
    </form>
  );
}
