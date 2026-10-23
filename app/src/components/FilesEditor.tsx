import { useEffect, useRef, useState } from 'react';
import { Text } from '@langchain/macaw-components/Text';
import { errorMessage, type TestFile } from '../lib/data';
import { fileUrl, isWeb, removeFile, uploadFile } from '../runs';
import { RemoveButton, Subsection } from './fields';

// Files the agent gets with the prompt: a photo to lighten, a video to caption. Each is stored on the test
// (a LangSmith example attachment) and listed in inputs.attachments with its hash, so replacing one counts as
// editing the test. Changes save immediately (not on autosave) because the bytes go straight to the server.
// Nothing shows until the test has a file: Given's Add ▾ › File bumps `pick`, which opens the file picker.
export function FilesEditor({ exampleId, files, onChange, pick = 0 }: { exampleId: string; files: TestFile[]; onChange: (files: TestFile[]) => void; pick?: number }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  const web = isWeb();
  useEffect(() => {
    if (pick && web) input.current?.click();
  }, [pick, web]);

  const run = async (label: string, change: () => Promise<TestFile[]>) => {
    setBusy(label);
    setProblem('');
    try {
      onChange(await change());
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy('');
    }
  };

  const picker = (
    <input ref={input} type="file" className="hidden" accept="image/*,video/*,audio/*,application/pdf,text/*"
      onChange={(event) => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file) void run('Uploading…', () => uploadFile(exampleId, file));
      }} />
  );
  if (!files.length && !busy && !problem) return picker;
  return (
    <Subsection title="Files" addLabel={busy || 'Add file'}
      hint={web ? undefined : 'Add files from the web editor, or with server/attach.py.'}
      onAdd={web && !busy ? () => input.current?.click() : undefined}>
      {picker}
      {files.length ? (
        <div className="flex flex-wrap gap-space-3">
          {files.map((file) => (
            <div key={file.name} className="flex w-48 flex-col gap-space-1 rounded-md border border-default p-space-2">
              <Preview exampleId={exampleId} file={file} web={web} />
              <div className="flex items-center justify-between gap-space-1">
                <span className="truncate text-xs text-primary" title={`${file.name} · ${file.mime_type}`}>{file.name}</span>
                {web ? <RemoveButton label={`Remove ${file.name}`} onClick={() => void run('Removing…', () => removeFile(exampleId, file.name))} /> : null}
              </div>
            </div>
          ))}
        </div>
      ) : <Text variant="xs" color="tertiary">No files.</Text>}
      {problem ? <span className="text-xs text-error-primary">{problem}</span> : null}
    </Subsection>
  );
}

function Preview({ exampleId, file, web }: { exampleId: string; file: TestFile; web: boolean }) {
  const box = 'h-28 w-full rounded bg-secondary object-contain';
  if (!web) return <div className={`${box} flex items-center justify-center text-xs text-tertiary`}>{file.mime_type}</div>;
  if (file.mime_type.startsWith('image/')) return <img src={fileUrl(exampleId, file)} alt={file.name} className={box} />;
  if (file.mime_type.startsWith('video/')) return <video src={fileUrl(exampleId, file)} className={box} controls muted />;
  if (file.mime_type.startsWith('audio/')) return <audio src={fileUrl(exampleId, file)} className="w-full" controls />;
  return <a href={fileUrl(exampleId, file)} target="_blank" rel="noreferrer" className={`${box} flex items-center justify-center text-xs underline`}>{file.mime_type}</a>;
}
