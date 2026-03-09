interface Props {
  status: string;
  className?: string;
}

const colors: Record<string, string> = {
  passed: 'bg-green-500/20 text-green-400 border-green-500/30',
  succeeded: 'bg-green-500/20 text-green-400 border-green-500/30',
  failed: 'bg-red-500/20 text-red-400 border-red-500/30',
  error: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  timeout: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
  skipped: 'bg-gray-500/20 text-gray-400 border-gray-500/30',
  running: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  completed: 'bg-green-500/20 text-green-400 border-green-500/30',
};

export default function TestResultBadge({ status, className = '' }: Props) {
  const color = colors[status] ?? colors['error'];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${color} ${className}`}>
      {status}
    </span>
  );
}
