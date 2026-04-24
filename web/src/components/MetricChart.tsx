import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer } from "recharts";

interface Point {
  name: string;
  value: number;
}

export default function MetricChart({ data, label }: { data: Point[]; label: string }) {
  return (
    <div className="bg-surface rounded-xl border border-border p-4">
      <h4 className="text-sm font-medium text-white mb-4">{label}</h4>
      <div className="h-56">
        <ResponsiveContainer>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" stroke="#2a2a32" />
            <XAxis dataKey="name" tick={{ fill: "#6b7280", fontSize: 12 }} stroke="#2a2a32" />
            <YAxis tick={{ fill: "#6b7280", fontSize: 12 }} stroke="#2a2a32" />
            <Tooltip contentStyle={{ background: "#17171c", border: "1px solid #2a2a32", borderRadius: 8, color: "#fff" }} />
            <Line type="monotone" dataKey="value" stroke="#e82127" strokeWidth={2} dot={{ fill: "#e82127", r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
