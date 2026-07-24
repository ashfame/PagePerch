import { describe, expect, it, vi } from 'vitest';

import { enableActionSidePanel } from './sidePanelBehavior';

describe('enableActionSidePanel', () => {
  it('makes the toolbar action open the global side panel', async () => {
    const setPanelBehavior = vi.fn(() => Promise.resolve());

    await enableActionSidePanel({ setPanelBehavior });

    expect(setPanelBehavior).toHaveBeenCalledOnce();
    expect(setPanelBehavior).toHaveBeenCalledWith({
      openPanelOnActionClick: true,
    });
  });
});
