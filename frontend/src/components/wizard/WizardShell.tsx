import type { ReactNode } from 'react';
import DialogHeader from '../DialogHeader';

interface WizardStep {
  id: string;
  label: string;
}

interface WizardShellProps {
  title: string;
  steps: WizardStep[];
  stepIdx: number;
  onJumpTo: (index: number) => void;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
  // Rendered between the header and the body. The agent wizard uses it for a
  // "could not load defaults" warning.
  banner?: ReactNode;
  children: ReactNode;
}

/**
 * The frame both config wizards share: a wide dialog with a numbered step
 * rail on the left, a scrolling pane on the right, and Back/Next/Close.
 * Only the title, the step list and the pane contents differ between them.
 */
export default function WizardShell({
  title,
  steps,
  stepIdx,
  onJumpTo,
  onBack,
  onNext,
  onClose,
  banner,
  children,
}: WizardShellProps) {
  const onLastStep = stepIdx >= steps.length - 1;

  return (
    <div
      className="ui-overlay"
      onClick={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="ui-dialog max-h-[90vh] w-[58rem] max-w-full"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <DialogHeader title={title} onClose={onClose} />

        {banner}

        <div className="wizard-body">
          <aside className="wizard-stepper">
            {steps.map((s, i) => {
              const cls = ['wizard-step'];
              if (i === stepIdx) cls.push('wizard-step-active');
              else if (i < stepIdx) cls.push('wizard-step-done');
              return (
                <button
                  key={s.id}
                  type="button"
                  className={cls.join(' ')}
                  aria-current={i === stepIdx ? 'step' : undefined}
                  onClick={() => onJumpTo(i)}
                >
                  <span className="wizard-step-num">{i + 1}</span>
                  <span className="wizard-step-label">{s.label}</span>
                </button>
              );
            })}
          </aside>

          <section className="wizard-pane">{children}</section>
        </div>

        <div className="ui-dialog-footer">
          <button
            type="button"
            className="btn btn-sm btn-soft"
            onClick={onBack}
            disabled={stepIdx === 0}
          >
            Back
          </button>
          {onLastStep ? (
            <button type="button" className="btn btn-sm btn-soft" onClick={onClose}>
              Close
            </button>
          ) : (
            <button type="button" className="btn btn-sm btn-primary" onClick={onNext}>
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
