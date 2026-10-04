import { Check } from "lucide-react";

export function Timeline({
  steps,
  stepTimes,
  step,
}: {
  steps: string[];
  stepTimes: string[];
  step: number;
}) {
  return (
    <div className="flex flex-col">
      {steps.map((label, i) => {
        const done = i < step;
        const current = i === step;
        const last = i === steps.length - 1;
        return (
          <div key={label} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div
                className={`flex size-7 shrink-0 items-center justify-center rounded-full ${
                  done
                    ? "bg-forest text-white"
                    : current
                      ? "border-[3px] border-carrot bg-white"
                      : "border-2 border-line bg-white"
                }`}
              >
                {done && <Check className="size-4" strokeWidth={3} />}
              </div>
              {!last && (
                <div
                  className={`w-0.5 flex-1 py-0.5 ${
                    done ? "bg-forest" : "bg-line"
                  }`}
                />
              )}
            </div>
            <div className={last ? "pb-1" : "pb-5"}>
              <div
                className={`text-[14px] font-bold ${
                  done || current ? "text-ink" : "text-ink-soft"
                }`}
              >
                {label}
              </div>
              <div className="text-[12px] text-ink-soft">{stepTimes[i]}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function StepBar({
  steps,
  step,
}: {
  steps: string[];
  step: number;
}) {
  return (
    <div className="flex items-start">
      {steps.map((label, i) => {
        const done = i < step;
        const current = i === step;
        return (
          <div key={label} className="flex flex-1 items-start last:flex-none">
            <div className="flex flex-col items-center gap-1">
              <div
                className={`flex size-7 items-center justify-center rounded-full ${
                  done
                    ? "bg-forest text-white"
                    : current
                      ? "bg-forest text-white ring-4 ring-forest/20"
                      : "border-2 border-line bg-white"
                }`}
              >
                {done && <Check className="size-4" strokeWidth={3} />}
              </div>
              <span
                className={`whitespace-nowrap text-[11px] font-bold ${
                  done || current ? "text-ink" : "text-ink-soft"
                }`}
              >
                {label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div
                className={`mx-1 mt-3 h-0.5 flex-1 ${done ? "bg-forest" : "bg-line"}`}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
