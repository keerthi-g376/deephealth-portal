import { MinusIcon, PlusIcon } from './icons.jsx';

// Small "– 1 +" quantity control. `value` is the shown number; the parent decides what −/+ do.
export default function Stepper({ value, onMinus, onPlus, minusDisabled, plusDisabled, label = 'quantity', size = 'sm' }) {
  return (
    <div className={`stepper stepper-${size}`}>
      <button type="button" onClick={onMinus} disabled={minusDisabled} aria-label={`Decrease ${label}`}>
        <MinusIcon width={12} height={12} />
      </button>
      <span aria-live="polite">{value}</span>
      <button type="button" onClick={onPlus} disabled={plusDisabled} aria-label={`Increase ${label}`}>
        <PlusIcon width={12} height={12} />
      </button>
    </div>
  );
}
