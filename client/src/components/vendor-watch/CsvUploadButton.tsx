import { useRef } from 'react';
import { Upload } from 'lucide-react';

/** A piece list is a few KB; anything this big is the wrong file. */
const MAX_CSV_BYTES = 1024 * 1024;

/** Opens a file picker and hands over the picked file's text. Too big or unreadable files go to onError. */
export default function CsvUploadButton({ onText, onError, disabled, className }: {
  onText: (text: string, fileName: string) => void;
  onError: (message: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  const input = useRef<HTMLInputElement>(null);

  const read = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_CSV_BYTES) {
      onError(`${file.name} is over 1 MB. A piece list should be much smaller.`);
      return;
    }
    try {
      onText(await file.text(), file.name);
    } catch (e) {
      onError(`Couldn't read ${file.name}: ${(e as Error).message}`);
    }
  };

  return (
    <>
      <input ref={input} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="hidden"
        onChange={e => { void read(e.target.files?.[0]); e.target.value = ''; }} />
      <button type="button" disabled={disabled} className={`flex items-center gap-1 ${className ?? ''}`}
        title="A CSV with a column of piece names: @activepieces/piece-slack, slack or Slack. Other columns are ignored."
        onClick={() => input.current?.click()}>
        <Upload size={12} /> Upload CSV
      </button>
    </>
  );
}
