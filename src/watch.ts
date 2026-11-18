import type { Report } from './report.ts';

export type Reporter = (report: Report) => Promise<void>;

export type WatchResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; crashReported: boolean };

export interface WatchOptions<T> {
  name: string;
  /** Do the run and send its normal report. Anything it throws is treated as a crash. */
  job: () => Promise<T>;
  /** Where the "could not run" notice goes. Use the same channel the normal report uses. */
  reporter: Reporter;
  onEvent?: (event: string, fields: Record<string, unknown>) => void;
}

/**
 * Who watches the watcher. A scheduled eval that crashes before it reports
 * looks exactly like a week with nothing to say, so the crash itself has to
 * produce a report. This never throws: if the job fails it sends a crash
 * notice, and if that also fails it says so through `onEvent` and in the
 * result, so the caller's own logs still carry it.
 */
export async function runWatched<T>(opts: WatchOptions<T>): Promise<WatchResult<T>> {
  const emit = opts.onEvent ?? (() => {});
  try {
    return { ok: true, value: await opts.job() };
  } catch (e) {
    const error = String(e).slice(0, 500);
    emit('golden.crashed', { name: opts.name, error });
    try {
      await opts.reporter({
        subject: `${opts.name} golden: the report could not run`,
        text: `The ${opts.name} golden run failed before it could report.\n\nNo agreement figure exists for this run. Treat it as unmeasured, not as passing.\n\nError: ${error}`,
      });
      return { ok: false, error, crashReported: true };
    } catch (reportErr) {
      emit('golden.crash_report_failed', { name: opts.name, cause: String(reportErr).slice(0, 300) });
      return { ok: false, error, crashReported: false };
    }
  }
}
