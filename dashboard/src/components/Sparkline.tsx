import {
  LineChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatBucketLocal } from "../lib/format";
import { formatMetric, type MetricField } from "../lib/metricHelp";

export interface SparkPoint {
  bucket_hour_iso: string;
  value: number;
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
            const v = Number(value);
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
