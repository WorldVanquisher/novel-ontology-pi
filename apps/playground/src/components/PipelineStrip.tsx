const STAGES = ["Sectioning", "Miniloop / Jev", "Extraction", "ChangeSet", "Merge gate"];

export function PipelineStrip({ stage }: { stage: number }) {
  return (
    <div className="pipeline">
      <span className="eyebrow">Processing / 01—05</span>
      <ol aria-label="Processing pipeline">
        {STAGES.map((label, index) => (
          <li key={label} className={index < stage ? "complete" : index === stage ? "current" : ""} aria-current={index === stage ? "step" : undefined}>
            <span>{String(index + 1).padStart(2, "0")}</span>{label}
          </li>
        ))}
      </ol>
    </div>
  );
}
