import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import NetworksField from '../NetworksField';
import type { KnownNetwork } from '../../../util/networks';

const KNOWN: KnownNetwork[] = [
  { id: 'pubnet', title: 'PUBNET 10.8.0.0/24' },
  { id: 'ovh', title: '' },
  { id: 'zone', title: 'Availability zone A' },
];

// The real field is controlled by InfoTab, so drive it the same way here -
// otherwise typing would not update `value` and the token logic never moves.
function Harness({
  initial = '',
  onCommit = vi.fn(),
}: {
  initial?: string;
  onCommit?: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <NetworksField value={value} onChange={setValue} onCommit={onCommit} known={KNOWN} />
      <button>elsewhere</button>
    </>
  );
}

const field = () => screen.getByRole('combobox', { name: 'Networks' }) as HTMLInputElement;

describe('NetworksField', () => {
  it('offers every unused network on focus, with its title', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(field());
    const options = await screen.findAllByRole('option');
    expect(options.map(o => o.textContent)).toEqual([
      'pubnetPUBNET 10.8.0.0/24',
      'ovh',
      'zoneAvailability zone A',
    ]);
  });

  it('filters on the id and on the title', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(field());
    await user.type(field(), 'zon');
    await waitFor(() =>
      expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual([
        'zoneAvailability zone A',
      ]),
    );

    await user.clear(field());
    await user.type(field(), 'availability');
    await waitFor(() =>
      expect(screen.getAllByRole('option').map(o => o.textContent)).toEqual([
        'zoneAvailability zone A',
      ]),
    );
  });

  it('completes the token under the caret, leaving the rest of the list alone', async () => {
    const user = userEvent.setup();
    render(<Harness initial="ovh," />);

    await user.click(field());
    field().setSelectionRange(4, 4);
    await user.type(field(), 'pub');
    await user.click(await screen.findByRole('option', { name: /pubnet/ }));

    await waitFor(() => expect(field().value).toBe('ovh,pubnet'));
  });

  it('does not offer a network already in the list', async () => {
    const user = userEvent.setup();
    render(<Harness initial="ovh," />);

    await user.click(field());
    field().setSelectionRange(4, 4);
    await user.type(field(), 'o');

    // "ovh" is claimed, so the only "o" match left is the one in "zone".
    await waitFor(() =>
      expect(screen.queryByRole('option', { name: /^ovh$/ })).not.toBeInTheDocument(),
    );
  });

  it('picks the highlighted match with the keyboard', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(field());
    // Nothing is highlighted until the operator arrows, so the first
    // ArrowDown lands on the FIRST suggestion.
    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() => expect(field().value).toBe('pubnet'));
  });

  // The whole point of the typeahead is to stop a typo becoming a second,
  // near-identical network. It must never rewrite what was typed on its own:
  // "pub" with "pubnet" in the list has to stay "pub" until it is chosen.
  it('commits what was typed when no suggestion is highlighted', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    await user.click(field());
    await user.type(field(), 'pub');
    expect(await screen.findByRole('option', { name: /pubnet/ })).toBeInTheDocument();
    await user.keyboard('{Enter}');

    expect(onCommit).toHaveBeenCalled();
    expect(field().value).toBe('pub');
  });

  it('ArrowUp past the first option returns to committing what was typed', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    await user.click(field());
    await user.type(field(), 'pub');
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');

    expect(onCommit).toHaveBeenCalled();
    expect(field().value).toBe('pub');
  });

  it('points aria-activedescendant at the highlighted option', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(field());
    expect(field()).not.toHaveAttribute('aria-activedescendant');

    await user.keyboard('{ArrowDown}');
    await waitFor(() => {
      const id = field().getAttribute('aria-activedescendant');
      expect(id).toBeTruthy();
      expect(document.getElementById(id!)).toHaveAttribute('aria-selected', 'true');
    });
  });

  it('commits when focus leaves the field', async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<Harness onCommit={onCommit} />);

    await user.click(field());
    await user.type(field(), 'prod');
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));

    expect(onCommit).toHaveBeenCalled();
  });

  // The agent panel closes on Escape; the first press must only close the
  // suggestion list.
  it('Escape closes the list without bubbling', async () => {
    const user = userEvent.setup();
    const onEscape = vi.fn();
    render(
      <div onKeyDown={e => e.key === 'Escape' && onEscape()}>
        <Harness />
      </div>,
    );

    await user.click(field());
    expect(await screen.findByRole('listbox')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(onEscape).not.toHaveBeenCalled();
  });
});
