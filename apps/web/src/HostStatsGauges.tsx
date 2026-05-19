import { useCallback, useEffect, useState } from "react";
import { api } from "./api.js";

export type HostStatsSnapshot = {
  cpuPercent: number;
  cpuCores: number;
  memUsedBytes: number;
  memTotalBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
  diskUsedBytes: number;
  diskTotalBytes: number;
  diskMount: string;
};

type StatsResponse = { ok: true; stats: HostStatsSnapshot };

function formatBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(2)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(2)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function pct(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

function ringColor(percent: number): string {
  if (percent >= 90) return "var(--danger)";
  if (percent >= 75) return "var(--sun-glint)";
  return "var(--accent)";
}

function StatRing(props: {
  title: string;
  subtitle: string;
  percent: number;
  center: string;
}) {
  const size = 92;
  const r = 38;
  const c = 2 * Math.PI * r;
  const dash = (props.percent / 100) * c;
  const stroke = ringColor(props.percent);
  return (
    <div className="stats-gauge">
      <p className="stats-gauge-title">{props.title}</p>
      <p className="stats-gauge-sub muted">{props.subtitle}</p>
      <div className="stats-gauge-ring-wrap">
        <svg className="stats-gauge-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="rgba(148, 189, 200, 0.22)"
            strokeWidth={7}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={stroke}
            strokeWidth={7}
            strokeLinecap="round"
            strokeDasharray={`${dash} ${c - dash}`}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
        <span className="stats-gauge-center">{props.center}</span>
      </div>
    </div>
  );
}

export function HostStatsGauges(props: { apiPath: string; className?: string }) {
  const [stats, setStats] = useState<HostStatsSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api<StatsResponse>(props.apiPath);
      setStats(r.stats);
      setErr(null);
    } catch (e) {
      setStats(null);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [props.apiPath]);

  useEffect(() => {
    setLoading(true);
    void load();
    const t = window.setInterval(() => void load(), 45_000);
    return () => window.clearInterval(t);
  }, [load]);

  if (loading && !stats) {
    return <p className="muted stats-gauges-row">Загрузка метрик…</p>;
  }

  if (err && !stats) {
    return (
      <p className="muted stats-gauges-row" style={{ fontSize: "0.85rem" }}>
        {err}
      </p>
    );
  }

  if (!stats) return null;

  const memPct = pct(stats.memUsedBytes, stats.memTotalBytes);
  const swapPct = pct(stats.swapUsedBytes, stats.swapTotalBytes);
  const diskPct = pct(stats.diskUsedBytes, stats.diskTotalBytes);

  return (
    <div className={`stats-gauges-row ${props.className ?? ""}`.trim()}>
      <StatRing
        title={`ЦП: ${stats.cpuCores} Core${stats.cpuCores > 1 ? "s" : ""}`}
        subtitle=" "
        percent={stats.cpuPercent}
        center={`${stats.cpuPercent.toFixed(2)}%`}
      />
      <StatRing
        title={`ОЗУ: ${formatBytes(stats.memUsedBytes)} / ${formatBytes(stats.memTotalBytes)}`}
        subtitle=" "
        percent={memPct}
        center={`${memPct.toFixed(2)}%`}
      />
      <StatRing
        title={`Файл подкачки: ${formatBytes(stats.swapUsedBytes)} / ${formatBytes(stats.swapTotalBytes)}`}
        subtitle=" "
        percent={swapPct}
        center={`${swapPct.toFixed(2)}%`}
      />
      <StatRing
        title={`Диск: ${formatBytes(stats.diskUsedBytes)} / ${formatBytes(stats.diskTotalBytes)}`}
        subtitle={stats.diskMount}
        percent={diskPct}
        center={`${diskPct.toFixed(1)}%`}
      />
    </div>
  );
}
