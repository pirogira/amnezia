import type { FastifyInstance } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import { getDb } from "../db.js";
import { verifyPassword, hashPassword } from "../password.js";
import { config } from "../config.js";
import { writeAudit } from "../audit.js";
import { randomUUID } from "node:crypto";

const loginBody = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

const registerBody = loginBody;

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/auth/login-info", async () => {
    const db = getDb();
    const n = db.prepare(`SELECT COUNT(*) as c FROM admins`).get() as { c: number };
    const exposeDevPassword =
      process.env.NODE_ENV !== "production" &&
      process.env.PANEL_SHOW_LOGIN_PASSWORD === "true" &&
      Boolean(config.bootstrapPassword);
    return {
      defaultUsername: config.bootstrapUsername,
      hasAdmins: n.c > 0,
      /** Только dev + явный флаг; в production всегда null */
      devPassword: exposeDevPassword ? config.bootstrapPassword : null,
      helpRu:
        "Логин по умолчанию — из PANEL_BOOTSTRAP_USERNAME (.env). Пароль — из PANEL_BOOTSTRAP_PASSWORD; на сервере после install.sh смотрите файл panel-credentials.txt. В браузере пароль по умолчанию не показывается из соображений безопасности. Для локальной отладки можно добавить в .env строку PANEL_SHOW_LOGIN_PASSWORD=true (только не в production).",
    };
  });

  await app.register(async (limited) => {
    await limited.register(rateLimit, {
      max: 40,
      timeWindow: "15 minutes",
    });

    limited.post("/auth/login", async (req, reply) => {
      const parsed = loginBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const { username, password } = parsed.data;
      const db = getDb();
      const row = db
        .prepare(`SELECT id, password_hash FROM admins WHERE username = ?`)
        .get(username) as { id: string; password_hash: string } | undefined;
      if (!row || !verifyPassword(password, row.password_hash)) {
        writeAudit(null, "login_failed", { username });
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      const token = await reply.jwtSign({ sub: row.id });
      writeAudit(row.id, "login_ok", { username });
      return { token };
    });

    limited.post("/auth/register", async (req, reply) => {
      if (!config.allowRegister) return reply.code(403).send({ error: "registration_disabled" });
      const parsed = registerBody.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body" });
      const { username, password } = parsed.data;
      const db = getDb();
      const id = randomUUID();
      const now = new Date().toISOString();
      try {
        const h = hashPassword(password);
        db.prepare(`INSERT INTO admins (id, username, password_hash, created_at) VALUES (?,?,?,?)`).run(
          id,
          username,
          h,
          now,
        );
      } catch {
        return reply.code(409).send({ error: "username_taken" });
      }
      writeAudit(id, "register", { username });
      const token = await reply.jwtSign({ sub: id });
      return { token };
    });
  });

  app.get("/me", async (req, reply) => {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: "unauthorized" });
    }
    const sub = (req.user as { sub: string }).sub;
    const row = getDb()
      .prepare(`SELECT id, username, created_at FROM admins WHERE id = ?`)
      .get(sub) as { id: string; username: string; created_at: string } | undefined;
    if (!row) return reply.code(401).send({ error: "unauthorized" });
    return row;
  });
}
