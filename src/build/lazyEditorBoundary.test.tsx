import { render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { LazyPageNoteEditor } from '../side-panel/LazyPageNoteEditor';

const editorModule = vi.hoisted(() => ({ loads: 0 }));

vi.mock('../side-panel/PageNoteEditor', async () => {
  editorModule.loads += 1;
  const React = await import('react');

  return {
    PageNoteEditor: ({
      onLoading,
      onReady,
    }: {
      readonly onLoading: () => void;
      readonly onReady: () => void;
    }) => {
      React.useEffect(() => {
        onLoading();
        onReady();
      }, [onLoading, onReady]);

      return React.createElement(
        'section',
        { 'aria-label': 'Page note editor' },
        'Loaded editor',
      );
    },
  };
});

it('does not evaluate the editor module until the lazy editor is mounted', async () => {
  const onLoading = vi.fn();
  const onReady = vi.fn();

  expect(editorModule.loads).toBe(0);

  render(
    <LazyPageNoteEditor
      editorMode="text-focused-blocks"
      initialContentHtml=""
      onContentChange={vi.fn()}
      onError={vi.fn()}
      onLoading={onLoading}
      onReady={onReady}
    />,
  );

  expect(onLoading).not.toHaveBeenCalled();
  expect(
    await screen.findByRole('region', { name: 'Page note editor' }),
  ).toHaveTextContent('Loaded editor');
  expect(editorModule.loads).toBe(1);
  await waitFor(() => {
    expect(onLoading).toHaveBeenCalledOnce();
    expect(onReady).toHaveBeenCalledOnce();
  });
});
