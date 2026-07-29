import {
  useEffect,
  useState,
  type ComponentType,
  type ReactElement,
} from 'react';

import type { PageNoteEditorProps } from './PageNoteEditor';

type PageNoteEditorComponent = ComponentType<PageNoteEditorProps>;

interface EditorModule {
  readonly PageNoteEditor: PageNoteEditorComponent;
}

let editorModulePromise: Promise<EditorModule> | undefined;

function loadEditorModule(): Promise<EditorModule> {
  editorModulePromise ??= import('./PageNoteEditor');

  return editorModulePromise;
}

export function LazyPageNoteEditor(
  props: PageNoteEditorProps,
): ReactElement | null {
  const [Editor, setEditor] = useState<PageNoteEditorComponent | undefined>(
    undefined,
  );
  const [reportLoadError] = useState(() => props.onError);

  useEffect(() => {
    let active = true;

    void loadEditorModule().then(
      ({ PageNoteEditor }) => {
        if (active) {
          setEditor(() => PageNoteEditor);
        }
      },
      (error: unknown) => {
        if (active) {
          reportLoadError(
            error instanceof Error
              ? error
              : new Error('PagePerch could not load the note editor.', {
                  cause: error,
                }),
          );
        }
      },
    );

    return () => {
      active = false;
    };
  }, [reportLoadError]);

  return Editor === undefined ? null : <Editor {...props} />;
}
