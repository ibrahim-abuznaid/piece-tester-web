import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = { resetKey: string; children: ReactNode };
type State = { error: Error | null };

/** Shows a reload banner in place of a page that failed to load or render, and clears it when resetKey changes. */
export default class PageErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page failed to load or render:', error, info.componentStack);
  }

  componentDidUpdate(prevProps: Props, prevState: State) {
    if (prevState.error && this.state.error && prevProps.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div role="alert" className="flex items-center justify-between rounded border border-red-800/60 bg-red-900/20 px-3 py-2 text-[12px] text-red-300">
        <span>Couldn't load this page. The app may have just been updated.</span>
        <button type="button" onClick={() => location.reload()} className="text-red-200 underline">Reload</button>
      </div>
    );
  }
}
