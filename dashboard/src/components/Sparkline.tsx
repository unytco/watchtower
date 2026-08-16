import { LineChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatBucketLocal } from "../lib/format";
import { formatMetric, type MetricField } from "../lib/metricHelp";

export interface SparkPoint {
  bucket_hour_iso: string;
  // null draws a gap (a degraded/unknown bucket), not a dip to zero — recharts
  // skips null points because `connectNulls` defaults to false (B107).
  value: number | null;
}

export function Sparkline({
  data,
  height = 60,
  field,
}: {
  data: SparkPoint[];
  height?: number;
  field?: MetricField;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 4, right: 8, bottom: 4, left: 8 }}>
        <XAxis dataKey="bucket_hour_iso" hide />
        <YAxis hide domain={["auto", "auto"]} />
        <Tooltip
          contentStyle={{
            background: "#11141a",
            border: "1px solid #1f2430",
            fontSize: 12,
          }}
          labelFormatter={(label) => formatBucketLocal(String(label))}
          formatter={(value: number) => {
            // recharts types this as a number, but a gap (degraded) bucket can
            // arrive as null at runtime; render "—", never a fake 0 —
            // Number(null) === 0 (B107).
            const v: number | null = value;
            if (v == null || !Number.isFinite(v)) return ["—", ""];
            return [field ? formatMetric(field, v) : v.toFixed(2), ""];
          }}
        />
        <Line
          type="monotone"
          dataKey="value"
          stroke="#5aa9ff"
          strokeWidth={1.5}
          dot={false}
          activeDot={{ r: 3, fill: "#5aa9ff" }}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
