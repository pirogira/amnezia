import Database from "better-sqlite3";
import { config, ensureDatabaseDir } from "./config.js";

const schema = `
CREATE TABLE IF NOT EXISTS admins (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vpn_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ssh_host TEXT NOT NULL,
  ssh_port INTEGER NOT NULL,
  ssh_user TEXT NOT NULL,
  ssh_private_key_enc TEXT NOT NULL,
  ssh_password_enc TEXT,
  docker_wg_container TEXT NOT NULL,
  wg_interface TEXT NOT NULL DEFAULT 'wg0',
  vpn_subnet_cidr TEXT NOT NULL,
  endpoint_host TEXT NOT NULL,
  listen_port INTEGER NOT NULL DEFAULT 51820,
  docker_compose_path TEXT,
  compose_service_name TEXT,
  port_change_hook_cmd TEXT,
  driver_mode TEXT NOT NULL DEFAULT 'ssh',
  vless_reality_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vpn_clients (
  id TEXT PRIMARY KEY,
  server_id TEXT NOT NULL,
  name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  public_key TEXT NOT NULL,
  private_key_enc TEXT,
  client_conf_enc TEXT NOT NULL,
  assigned_ip TEXT NOT NULL,
  listen_port INTEGER NOT NULL,
  security_json TEXT NOT NULL,
  endpoint_host TEXT NOT NULL,
  revoked_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (server_id) REFERENCES vpn_servers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  admin_id TEXT,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_clients_server ON vpn_clients(server_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
`;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  ensureDatabaseDir();
  db = new Database(config.databasePath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(schema);
  const cols = db.prepare(`PRAGMA table_info(vpn_clients)`).all() as { name: string }[];
  if (cols.length && !cols.some((c) => c.name === "client_conf_enc")) {
    db.exec(`ALTER TABLE vpn_clients ADD COLUMN client_conf_enc TEXT`);
  }
  const srvCols = db.prepare(`PRAGMA table_info(vpn_servers)`).all() as { name: string }[];
  if (srvCols.length && !srvCols.some((c) => c.name === "ssh_password_enc")) {
    db.exec(`ALTER TABLE vpn_servers ADD COLUMN ssh_password_enc TEXT`);
  }
  const srvCols2 = db.prepare(`PRAGMA table_info(vpn_servers)`).all() as { name: string }[];
  if (srvCols2.length && !srvCols2.some((c) => c.name === "vless_reality_json")) {
    db.exec(`ALTER TABLE vpn_servers ADD COLUMN vless_reality_json TEXT`);
  }
  return db;
}
