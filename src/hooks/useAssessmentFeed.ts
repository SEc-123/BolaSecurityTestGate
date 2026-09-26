import { useEffect, useRef, useState } from 'react';
import type { ProductAssessmentState } from '../types/assessment';
import { assessmentApi } from '../lib/assessment-api';
import { connectAssessment, type AssessmentEventSource, type ConnectionState } from '../lib/assessment-feed';
export function useAssessmentFeed(runId: string) {
  const [state, setState] = useState<ProductAssessmentState | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const client = useRef<ReturnType<typeof connectAssessment> | null>(null);
  useEffect(() => {
    setState(null); setConnection('connecting');
    if (!runId) return;
    const feed = connectAssessment({ runId, url: assessmentApi.events(runId),
      read: signal => assessmentApi.read(runId, signal),
      createSource: typeof EventSource === 'undefined' ? undefined : url => new EventSource(url) as unknown as AssessmentEventSource,
      onState: setState, onConnection: setConnection });
    client.current = feed;
    const networkChanged = () => feed.setOnline(navigator.onLine);
    window.addEventListener('online', networkChanged); window.addEventListener('offline', networkChanged); networkChanged();
    return () => { window.removeEventListener('online', networkChanged); window.removeEventListener('offline', networkChanged); feed.close(); if (client.current === feed) client.current = null; };
  }, [runId]);
  // Rendering also guards the brief interval between a run switch and its effect cleanup.
  return { state: state?.run.id === runId ? state : null, connection, refresh: () => client.current?.refresh() };
}
