import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SidePanelApp } from './App';

describe('SidePanelApp', () => {
  it('renders an accessible local-first baseline and opens settings', async () => {
    const openOptionsPage = vi.fn(() => Promise.resolve());
    vi.stubGlobal('chrome', { runtime: { openOptionsPage } });
    const user = userEvent.setup();

    render(<SidePanelApp />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'PagePerch' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Notes for this page' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Local foundation ready',
    );

    await user.click(screen.getByRole('button', { name: 'Open settings' }));

    expect(openOptionsPage).toHaveBeenCalledOnce();
  });
});
