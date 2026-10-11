import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ErrorBoundary from '../ErrorBoundary';

// Child whose render can be made to throw on demand.
let shouldThrow = false;
function MaybeThrows() {
  if (shouldThrow) throw new Error('boom');
  return <div>healthy child</div>;
}

describe('ErrorBoundary', () => {
  afterEach(() => {
    shouldThrow = false;
    vi.restoreAllMocks();
  });

  it('renders children when nothing throws', () => {
    render(
      <ErrorBoundary label="panel">
        <MaybeThrows />
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy child')).toBeInTheDocument();
  });

  it('renders a fallback when a child throws during render', () => {
    // React logs the caught error to console.error; keep the output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    shouldThrow = true;
    render(
      <ErrorBoundary label="panel">
        <MaybeThrows />
      </ErrorBoundary>,
    );
    expect(screen.queryByText('healthy child')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong in the panel');
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });

  it('recovers when the operator retries and the child no longer throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    shouldThrow = true;
    render(
      <ErrorBoundary label="panel">
        <MaybeThrows />
      </ErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('healthy child')).toBeInTheDocument();
  });
});
