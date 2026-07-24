import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { OptionsApp } from './App';

describe('OptionsApp', () => {
  it('renders the planned settings areas with semantic headings', () => {
    render(<OptionsApp />);

    expect(
      screen.getByRole('heading', { level: 1, name: 'PagePerch settings' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Editor' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Page identity' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 2, name: 'Storage & sync' }),
    ).toBeInTheDocument();
  });
});
