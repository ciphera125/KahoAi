import { useId, useState } from "react";
import { missedCalls, formatCount, formatRupees, LIMITS, type CalcInput } from "../lib/calc";
import { calculator as copy } from "../content/content";

const FIELDS: { key: keyof CalcInput; max: number; step: string }[] = [
  { key: "callsPerDay", max: LIMITS.callsPerDay, step: "1" },
  { key: "missedPct", max: LIMITS.missedPct, step: "1" },
  { key: "customerValue", max: LIMITS.customerValue, step: "100" },
];

export function Calculator() {
  const id = useId();
  const [v, setV] = useState<CalcInput>({
    callsPerDay: copy.inputs.callsPerDay.start,
    missedPct: copy.inputs.missedPct.start,
    customerValue: copy.inputs.customerValue.start,
  });
  const r = missedCalls(v);

  return (
    <div className="k-calc k-card">
      <form className="k-calc-in" onSubmit={(e) => e.preventDefault()} aria-describedby={`${id}-ex`}>
        <p id={`${id}-ex`} className="k-calc-ex">{copy.exampleNote}</p>
        {FIELDS.map((f) => (
          <div key={f.key} className="k-field">
            <label htmlFor={`${id}-${f.key}`}>{copy.inputs[f.key].label}</label>
            <input id={`${id}-${f.key}`} type="number" inputMode="numeric" min="0" max={f.max} step={f.step}
              value={v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
          </div>
        ))}
      </form>
      <div className="k-calc-out" aria-live="polite">
        <dl>
          <div><dt>{copy.outputs.perDay}</dt><dd>{formatCount(r.perDay, 1)}</dd></div>
          <div><dt>{copy.outputs.perMonth}</dt><dd>{formatCount(r.perMonth, 0)}</dd></div>
          <div><dt>{copy.outputs.perMinute}</dt><dd>{formatCount(r.perMinute, 2)}</dd></div>
          <div className="k-calc-big"><dt>{copy.outputs.revenue}</dt><dd>{formatRupees(r.revenuePerMonth)}</dd></div>
        </dl>
        <p className="k-calc-note">{copy.note}</p>
      </div>
    </div>
  );
}
