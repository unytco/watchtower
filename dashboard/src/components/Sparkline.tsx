import { LineChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface SparkPoint {
  bucket_hour_iso: string;
  value: number;
}

export function Sparkline({ data, height = 60 }: { data: SparkPoint[]; height?: number }) {
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
          labelFormatter={(label) => String(label).slice(5, 16).replace("T", " ")}
        />
        <Line type="monotone" dataKey="value" stroke="#5aa9ff" strokeWidth={1.5} dot={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}
