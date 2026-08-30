import type { KeyboardEvent, ReactNode } from "react";
import "./workflow-stepper.css";

export interface WorkflowStepItem<T extends string> {
  disabled?: boolean;
  id: T;
  label: string;
  meta?: ReactNode;
  step: number;
  warning?: boolean;
}

export interface WorkflowStepperProps<T extends string> {
  activeStep: T;
  ariaLabel: string;
  idPrefix: string;
  onChange: (step: T) => void;
  steps: readonly WorkflowStepItem<T>[];
}

export function WorkflowStepper<T extends string>({
  activeStep,
  ariaLabel,
  idPrefix,
  onChange,
  steps,
}: WorkflowStepperProps<T>) {
  function handleKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    const direction = event.key === "ArrowRight"
      ? 1
      : event.key === "ArrowLeft"
        ? -1
        : 0;
    const enabledIndexes = steps
      .map((step, stepIndex) => step.disabled ? -1 : stepIndex)
      .filter((stepIndex) => stepIndex >= 0);
    const currentEnabledIndex = enabledIndexes.indexOf(index);
    const nextIndex = event.key === "Home"
      ? (enabledIndexes[0] ?? -1)
      : event.key === "End"
        ? (enabledIndexes[enabledIndexes.length - 1] ?? -1)
        : direction && enabledIndexes.length
          ? enabledIndexes[
            (currentEnabledIndex + direction + enabledIndexes.length)
              % enabledIndexes.length
          ] ?? -1
          : -1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const next = steps[nextIndex];
    if (!next) return;
    onChange(next.id);
    event.currentTarget.parentElement
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
      [nextIndex]?.focus();
  }

  return (
    <div
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      className="workflow-stepper"
      role="tablist"
    >
      {steps.map((step, index) => (
        <button
          aria-controls={`${idPrefix}-${step.id}-panel`}
          aria-current={activeStep === step.id ? "step" : undefined}
          aria-selected={activeStep === step.id}
          className="workflow-stepper-trigger"
          disabled={step.disabled}
          id={`${idPrefix}-${step.id}-tab`}
          key={step.id}
          onClick={() => onChange(step.id)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          role="tab"
          tabIndex={activeStep === step.id && !step.disabled ? 0 : -1}
          type="button"
        >
          <span aria-hidden="true" className="workflow-stepper-index">
            {step.step}
          </span>
          <span className="workflow-stepper-label">{step.label}</span>
          {step.meta !== undefined && (
            <span className="workflow-stepper-meta">{step.meta}</span>
          )}
          {step.warning && (
            <span aria-label="Attention required" className="workflow-stepper-warning" />
          )}
        </button>
      ))}
    </div>
  );
}
