import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import Alert from '../Alert';

describe('Alert', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the message and a dismiss button', () => {
    const onClose = vi.fn();
    render(<Alert kind="success" message="Added mesh" onClose={onClose} />);
    expect(screen.getByText('Added mesh')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Dismiss/ })).toBeInTheDocument();
  });

  it('auto-closes a success alert after the default 4s', () => {
    const onClose = vi.fn();
    render(<Alert kind="success" message="Added mesh" onClose={onClose} />);
    act(() => {
      vi.advanceTimersByTime(3999);
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('auto-closes an error alert after the default 8s', () => {
    const onClose = vi.fn();
    render(<Alert kind="error" message="boom" onClose={onClose} />);
    act(() => {
      vi.advanceTimersByTime(7999);
    });
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('respects a custom autoCloseMs', () => {
    const onClose = vi.fn();
    render(<Alert kind="success" message="x" onClose={onClose} autoCloseMs={1000} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not auto-close when autoCloseMs <= 0', () => {
    const onClose = vi.fn();
    render(<Alert kind="error" message="sticky" onClose={onClose} autoCloseMs={0} />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('fires onClose when the dismiss button is clicked', () => {
    const onClose = vi.fn();
    render(<Alert kind="success" message="x" onClose={onClose} />);
    // fireEvent (not userEvent) because the latter trips up under
    // vi.useFakeTimers and the button has no async behaviour to test.
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
