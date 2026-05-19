import Fastify from "fastify";
import cors from "@fastify/cors";
import jwt from "@fastify/jwt";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { config, ensureDatabaseDir } from "./config.js";
import { getDb } from "./db.js";
import { ensureBootstrapAdmin } from "./bootstrap.js";
import { authRoutes } from "./routes/auth.js";
import { serverRoutes } from "./routes/servers.js";
import { clientRoutes } from "./routes/clients.js";
import { statsRoutes } from "./routes/stats.js";

ensureDatabaseDir();
getDb();
ensureBootstrapAdmin();

const app = Fastify({
  logger: true,
  trustProxy: config.trustProxy,
});

await app.register(cors, {
  origin:
    config.corsOrigin === true
      ? true
      : String(config.corsOrigin)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
  credentials: true,
});
await app.register(helmet, { global: true, contentSecurityPolicy: false });
await app.register(rateLimit, {
  global: true,
  max: 500,
  timeWindow: "1 minute",
});

await app.register(jwt, {
  secret: config.jwtSecret,
  sign: { expiresIn: "7d" },
});

await app.register(async (scope) => {
  scope.get("/health", async () => ({ ok: true }));
  await scope.register(authRoutes);
  await scope.register(serverRoutes);
  await scope.register(clientRoutes);
  await scope.register(statsRoutes);
}, { prefix: "/api" });

app.get("/", async () => ({
  service: "amnesia-veb-api",
  health: "/api/health",
  hint:
    process.env.NODE_ENV === "production"
      ? "Откройте URL панели в браузере (тот же хост, что и для UI, через reverse proxy)."
      : "Интерфейс в режиме разработки: http://localhost:5173 — запустите из корня репозитория: npx dotenv-cli -e .env -- npm run dev",
}));

const address = await app.listen({ port: config.port, host: config.host });
app.log.info(`API listening at ${address}`);
