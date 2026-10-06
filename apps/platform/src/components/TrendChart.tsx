/** Server-rendered line chart for daily series. Pure SVG: no client JavaScript, works under the CSP. */
const COLORS = ["#0f6b4f", "#a8492a", "#3d5a99", "#8a6a12", "#7a3e8c", "#6a706c"];

export function TrendChart({ days, series, label }: { days: string[]; series: { key: string; counts: number[] }[]; label: string }) {
  const W = 720;
  const H = 220;
  const pad = { l: 40, r: 12, t: 12, b: 26 };
  const max = Math.max(1, ...series.flatMap((s) => s.counts));
  const step = Math.pow(10, Math.floor(Math.log10(max)));
  const top = Math.ceil(max / step) * step;
  const x = (i: number) => pad.l + (days.length <= 1 ? 0 : (i / (days.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / top) * (H - pad.t - pad.b);
  const ticks = [0, top / 2, top];
  const labelEvery = Math.max(1, Math.ceil(days.length / 8));
  return (
    <figure className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={label}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} stroke="#d8d4ca" strokeDasharray={v ? "3 3" : undefined} />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="#6a706c">{Number.isInteger(v) ? v.toLocaleString("en-US") : v.toFixed(1)}</text>
          </g>
        ))}
        {days.map((d, i) =>
          i % labelEvery === 0 || i === days.length - 1 ? (
            <text key={d} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="#6a706c">{d.slice(5)}</text>
          ) : null,
        )}
        {series.map((s, si) => (
          <g key={s.key}>
            <polyline fill="none" stroke={COLORS[si % COLORS.length]} strokeWidth="2" strokeLinejoin="round" points={s.counts.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
            {days.length <= 31 && s.counts.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="2.5" fill={COLORS[si % COLORS.length]}><title>{`${s.key} · ${days[i]}: ${v}`}</title></circle>)}
          </g>
        ))}
      </svg>
      {series.length > 1 && (
        <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
          {series.map((s, si) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2 w-3 rounded-sm" style={{ background: COLORS[si % COLORS.length] }} />
              {s.key}
            </span>
          ))}
        </figcaption>
      )}
    </figure>
  );
}
