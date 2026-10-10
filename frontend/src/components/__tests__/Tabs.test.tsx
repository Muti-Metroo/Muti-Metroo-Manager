import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Tabs from '../Tabs';

const TABS = [
  { id: 'info', label: 'Info' },
  { id: 'shell', label: 'Shell', disabled: true },
  { id: 'files', label: 'Files' },
];

describe('Tabs', () => {
  it('marks only the active tab as selected', () => {
    render(<Tabs tabs={TABS} activeId="files" onChange={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Info' })).toHaveAttribute('aria-selected', 'false');
  });

  it('reports the clicked tab', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Tabs tabs={TABS} activeId="info" onChange={onChange} />);

    await user.click(screen.getByRole('tab', { name: 'Files' }));
    expect(onChange).toHaveBeenCalledWith('files');
  });

  // A capability the agent does not offer stays visible but inert, so the
  // operator can see the tab exists rather than wondering where it went.
  it('renders a disabled tab that cannot be selected', () => {
    const onChange = vi.fn();
    render(<Tabs tabs={TABS} activeId="info" onChange={onChange} />);

    const shell = screen.getByRole('tab', { name: 'Shell' });
    expect(shell).toBeInTheDocument();
    expect(shell).toBeDisabled();

    // fireEvent, not userEvent: userEvent refuses to click a disabled element
    // at all, so it would pass even if the handler were still wired up.
    fireEvent.click(shell);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders the right slot alongside the strip', () => {
    render(
      <Tabs tabs={TABS} activeId="info" onChange={vi.fn()} rightSlot={<button>Actions</button>} />,
    );

    expect(screen.getByRole('button', { name: 'Actions' })).toBeInTheDocument();
  });
});
