import { useEffect, useMemo, useState } from "react";
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

type DiscoverWgOk = {
  dockerWgContainer: string;
  wgInterface: string;
  listenPort: number;
  vpnSubnetCidr: string | null;
  image?: string;
};

export function App() {
  const [token, setTok] = useState<string | null>(() => getToken());
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [serverAddMode, setServerAddMode] = useState<"manual" | "provision">("manual");
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
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.75rem" }}>
          <button
            type="button"
            className={serverAddMode === "manual" ? "btn primary" : "btn"}
            onClick={() => setServerAddMode("manual")}
          >
            Добавить вручную
          </button>
          <button
            type="button"
            className={serverAddMode === "provision" ? "btn primary" : "btn"}
            onClick={() => setServerAddMode("provision")}
          >
            Развернуть Amnezia на VPS
          </button>
        </div>
        {serverAddMode === "manual" ? (
          <ServerForm
            onCreated={async () => {
              const list = await api<Server[]>("/api/servers");
              setServers(list);
              setActiveServerId((prev) =>
                prev && list.some((s) => s.id === prev) ? prev : (list[0]?.id ?? null),
              );
            }}
          />
        ) : (
          <ProvisionServerForm
            onCreated={async () => {
              const list = await api<Server[]>("/api/servers");
              setServers(list);
              setActiveServerId((prev) =>
                prev && list.some((s) => s.id === prev) ? prev : (list[0]?.id ?? null),
              );
            }}
          />
        )}
        <div style={{ marginTop: "1rem", width: "100%" }}>
          <button
            type="button"
            className="btn btn-server-delete"
            disabled={servers.length === 0}
            onClick={async () => {
              if (servers.length === 0) return;
              const lines = servers.map((s, i) => `${i + 1}. ${s.name} (${s.sshHost})`).join("\n");
              const raw = window.prompt(
                `Какой сервер удалить? Введите номер из списка и нажмите OK.\n\n${lines}`,
              );
              if (raw == null) return;
              const n = Number.parseInt(String(raw).trim(), 10);
              if (!Number.isInteger(n) || n < 1 || n > servers.length) {
                window.alert("Неверный номер. Удаление отменено.");
                return;
              }
              const target = servers[n - 1]!;
              if (
                !window.confirm(
                  `Точно удалить сервер «${target.name}» и всех его клиентов из панели? Действие необратимо.`,
                )
              ) {
                return;
              }
              try {
                await api<{ ok: boolean }>(`/api/servers/${target.id}`, { method: "DELETE" });
                const list = await api<Server[]>("/api/servers");
                setServers(list);
                setActiveServerId((prev) => {
                  if (prev === target.id) return list[0]?.id ?? null;
                  return prev && list.some((x) => x.id === prev) ? prev : (list[0]?.id ?? null);
                });
                setLastConf(null);
                setLastVpnUri(null);
              } catch (e) {
                window.alert(e instanceof Error ? e.message : String(e));
              }
            }}
          >
            Удалить сервер…
          </button>
        </div>
      </div>

      {servers.length > 0 && (
        <div className="card clients-card">
          <h2 className="h2">Клиенты</h2>
          <div className="active-server-block">
            <label className="active-server-label" htmlFor="active-server-select">
              Активный сервер
            </label>
            <select
              id="active-server-select"
              className="active-server-select"
              value={activeServerId ?? ""}
              onChange={(e) => setActiveServerId(e.target.value || null)}
              disabled={servers.length === 0}
              aria-label="Выбор активного сервера"
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          {activeServer ? (
            <>
              <ClientForm
                key={activeServer.id}
                server={activeServer}
                onCreated={async (conf, vpnUri) => {
                  setLastConf(conf);
                  setLastVpnUri(vpnUri ?? null);
                  const list = await api<ClientRow[]>(`/api/servers/${activeServer.id}/clients`);
                  setClients(list);
                }}
              />
              {(lastVpnUri || lastConf) && (
                <LastIssuedBlock vpnUri={lastVpnUri} conf={lastConf} />
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
            </>
          ) : (
            <p className="muted" style={{ margin: "0.5rem 0 0" }}>
              Выберите сервер в списке выше.
            </p>
          )}
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

type ProvisionStep = {
  step: string;
  ok: boolean;
  message?: string;
  label?: string;
  durationMs?: number;
};

function ProvisionServerForm(props: { onCreated: () => Promise<void> }) {
  const [name, setName] = useState("New VPS");
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState(22);
  const [sshKey, setSshKey] = useState("");
  const [sshPassword, setSshPassword] = useState("");
  const [vlessJson, setVlessJson] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [steps, setSteps] = useState<ProvisionStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");

  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        setMsg(null);
        setSteps([]);
        setProgressPct(0);
        setProgressLabel("Подключение к API…");
        let vlessReality: VlessReality | undefined;
        if (vlessJson.trim()) {
          try {
            vlessReality = JSON.parse(vlessJson) as VlessReality;
          } catch {
            setMsg("Невалидный JSON в поле VLESS Reality");
            return;
          }
        }
        const tok = getToken();
        const body = JSON.stringify({
          name,
          sshHost,
          sshPort,
          sshUser: "root",
          sshPrivateKey: sshKey,
          sshPassword,
          vlessReality,
        });
        setBusy(true);
        try {
          const res = await fetch("/api/servers/provision?stream=1", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(tok ? { Authorization: `Bearer ${tok}` } : {}),
            },
            body,
          });
          const ct = res.headers.get("content-type") ?? "";
          if (!res.ok) {
            const j = (await res.json().catch(() => ({}))) as {
              message?: string;
              error?: string;
              details?: unknown;
            };
            const detail =
              j.details && typeof j.details === "object" ? JSON.stringify(j.details) : "";
            setMsg([j.message || j.error || `HTTP ${res.status}`, detail].filter(Boolean).join(" — "));
            setProgressLabel("");
            return;
          }
          if (!res.body || !ct.includes("ndjson")) {
            setMsg("Ожидался поток NDJSON от API (stream=1).");
            setProgressLabel("");
            return;
          }
          const reader = res.body.getReader();
          const dec = new TextDecoder();
          let buf = "";
          let finalSteps: ProvisionStep[] = [];
          let finalOk = false;
          let finalId: string | undefined;
          let finalErr: string | undefined;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const parts = buf.split("\n");
            buf = parts.pop() ?? "";
            for (const line of parts) {
              const t = line.trim();
              if (!t) continue;
              let ev: Record<string, unknown>;
              try {
                ev = JSON.parse(t) as Record<string, unknown>;
              } catch {
                continue;
              }
              const evName = String(ev.event ?? "");
              if (evName === "plan" && typeof ev.message === "string") {
                setProgressLabel(ev.message as string);
              }
              if (evName === "step_start" && typeof ev.label === "string") {
                setProgressLabel(String(ev.label));
              }
              if (evName === "wait_wg_pulse") {
                const sec = typeof ev.elapsedSec === "number" ? ev.elapsedSec : 0;
                const base =
                  typeof ev.label === "string" ? String(ev.label) : "Ожидание интерфейса WireGuard";
                setProgressLabel(`${base} (${sec}s)`);
              }
              if (evName === "step_end" && typeof ev.pct === "number") {
                setProgressPct(Math.min(100, Math.max(0, Number(ev.pct))));
              }
              if (evName === "result") {
                finalOk = Boolean(ev.ok);
                if (Array.isArray(ev.steps)) finalSteps = ev.steps as ProvisionStep[];
                if (finalOk && typeof ev.serverId === "string") finalId = ev.serverId;
                if (!finalOk && typeof ev.message === "string") finalErr = ev.message;
              }
            }
          }
          if (finalSteps.length) setSteps(finalSteps);
          if (finalOk && finalId) {
            setProgressPct(100);
            setProgressLabel("Готово");
            setMsg(`Сервер добавлен (id: ${finalId})`);
            await props.onCreated();
          } else {
            setProgressLabel("");
            setMsg(finalErr ?? "Развёртывание не завершилось");
          }
        } catch (err) {
          setMsg(err instanceof Error ? err.message : String(err));
          setProgressLabel("");
        } finally {
          setBusy(false);
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
        <input value="root" readOnly disabled />
      </div>
      <div className="field" style={{ flex: "1 1 240px" }}>
        <label>SSH private key</label>
        <textarea
          value={sshKey}
          onChange={(e) => setSshKey(e.target.value)}
          placeholder="OpenSSH PEM или пусто, если пароль"
          rows={5}
        />
      </div>
      <div className="field">
        <label>SSH пароль root</label>
        <input
          type="password"
          autoComplete="new-password"
          value={sshPassword}
          onChange={(e) => setSshPassword(e.target.value)}
        />
      </div>
      <div className="field" style={{ flex: "1 1 100%" }}>
        <label>VLESS Reality (JSON, опционально)</label>
        <textarea
          value={vlessJson}
          onChange={(e) => setVlessJson(e.target.value)}
          rows={3}
          style={{ fontFamily: "monospace", fontSize: "0.85rem" }}
        />
      </div>
      <button className="btn primary" type="submit" disabled={busy}>
        {busy ? "Развёртывание…" : "Развернуть"}
      </button>
      {busy && (
        <div style={{ width: "100%", marginTop: "0.75rem" }}>
          <div
            style={{
              height: 10,
              background: "#2a2a35",
              borderRadius: 5,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${progressPct}%`,
                background: "linear-gradient(90deg, #3b82f6, #6366f1)",
                transition: "width 0.25s ease-out",
              }}
            />
          </div>
          <p className="muted" style={{ margin: "0.35rem 0 0", fontSize: "0.85rem" }}>
            {progressPct}% · {progressLabel || "…"}
          </p>
        </div>
      )}
      {msg && (
        <p
          className={msg.startsWith("Сервер добавлен") ? "muted" : "error"}
          style={{ width: "100%", marginTop: "0.5rem" }}
        >
          {msg}
        </p>
      )}
      {steps.length > 0 && (
        <ul className="muted" style={{ width: "100%", margin: "0.5rem 0 0", fontSize: "0.85rem", paddingLeft: "1.2rem" }}>
          {steps.map((s, i) => (
            <li key={`${s.step}-${i}`}>
              <strong>{s.label ?? s.step}</strong>: {s.ok ? "ok" : "ошибка"}
              {s.durationMs != null ? ` (${s.durationMs} ms)` : ""}
              {s.message ? ` — ${s.message}` : ""}
            </li>
          ))}
        </ul>
      )}
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
  const [vlessJson, setVlessJson] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
        setBusy(true);
        try {
          const disc = await api<DiscoverWgOk>("/api/servers/discover-wg-docker", {
            method: "POST",
            json: {
              sshHost,
              sshPort,
              sshUser,
              sshPrivateKey: sshKey,
              sshPassword,
            },
          });
          const vpnSubnetCidr = disc.vpnSubnetCidr ?? "10.8.0.0/24";
          await api("/api/servers", {
            method: "POST",
            json: {
              name,
              sshHost,
              sshPort,
              sshUser,
              sshPrivateKey: sshKey,
              sshPassword,
              dockerWgContainer: disc.dockerWgContainer,
              wgInterface: disc.wgInterface,
              vpnSubnetCidr,
              endpointHost: sshHost.trim(),
              listenPort: disc.listenPort,
              driverMode: "ssh" as const,
              dockerComposePath: null,
              portChangeHookCmd: null,
              vlessReality,
            },
          });
          setMsg("Сервер добавлен");
          await props.onCreated();
        } catch (e) {
          setMsg(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
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
      <div className="field" style={{ flex: "1 1 100%" }}>
        <label>VLESS Reality (JSON, опционально)</label>
        <textarea
          value={vlessJson}
          onChange={(e) => setVlessJson(e.target.value)}
          rows={4}
          placeholder={`{\n  "pbk": "…",\n  "sni": "aws.amazon.com",\n  "sid": "8b"\n}`}
          style={{ fontFamily: "monospace", fontSize: "0.85rem" }}
        />
      </div>
      <button className="btn primary" type="submit" disabled={busy}>
        {busy ? "Поиск контейнера и добавление…" : "Добавить сервер"}
      </button>
      {msg && (
        <p className={msg === "Сервер добавлен" ? "muted" : "error"} style={{ width: "100%", marginTop: "0.5rem" }}>
          {msg}
        </p>
      )}
    </form>
  );
}

function LastIssuedBlock(props: { vpnUri: string | null; conf: string | null }) {
  const { vpnUri, conf } = props;
  if (vpnUri) {
    return (
      <div className="issued-vpn-block">
        <div className="issued-vpn-header">
          <span className="vpn-uri-badge">vpn://</span>
          <span className="vpn-uri-caption">импорт в приложение Amnezia</span>
        </div>
        <div className="vpn-uri-shell">
          <textarea
            readOnly
            className="vpn-uri-field"
            value={vpnUri}
            rows={7}
            spellCheck={false}
            aria-label="Ссылка vpn:// для импорта"
          />
        </div>
        <div className="vpn-uri-footer">
          <button type="button" className="btn primary" onClick={() => void navigator.clipboard.writeText(vpnUri)}>
            Копировать ссылку
          </button>
        </div>
      </div>
    );
  }
  if (conf) {
    return (
      <div className="issued-vpn-block issued-conf-fallback">
        <p className="muted" style={{ margin: "0 0 0.65rem", fontSize: "0.88rem" }}>
          Для этого протокола ссылка <code className="vpn-inline-code">vpn://</code> недоступна — ниже текст{" "}
          <code className="vpn-inline-code">.conf</code> или скачайте файл из таблицы.
        </p>
        <div className="vpn-uri-shell">
          <pre className="vpn-uri-field vpn-uri-field--conf">{conf}</pre>
        </div>
        <button
          type="button"
          className="btn primary"
          style={{ marginTop: "0.85rem" }}
          onClick={() => void navigator.clipboard.writeText(conf)}
        >
          Копировать .conf
        </button>
      </div>
    );
  }
  return null;
}

function ClientForm(props: {
  server: Server;
  onCreated: (conf: string, vpnUri?: string) => Promise<void>;
}) {
  const [name, setName] = useState("user1");
  const [protocol, setProtocol] = useState<VpnProtocol>("amneziawg");
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
          const r = await api<{ clientConf: string; id: string; assignedIp: string; vpnUri?: string }>(
            `/api/servers/${props.server.id}/clients`,
            {
              method: "POST",
              json: {
                name,
                protocol,
                listenPort: props.server.listenPort,
                security: {},
                expiresAt: null,
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
          Для VLESS на сервере нужен JSON VLESS Reality — добавьте сервер с этим полем или через API.
        </p>
      )}
      <button className="btn primary" type="submit" disabled={clientBusy}>
        {clientBusy ? "Создание…" : "Выдать клиента"}
      </button>
      {clientErr && <p className="error" style={{ width: "100%", margin: "0.5rem 0 0" }}>{clientErr}</p>}
    </form>
  );
}
