import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconRefreshCw } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { metricsEmbedApi, metricsEmbedRefreshDelay } from '@/services/api/metricsEmbed';
import { useAuthStore } from '@/stores';
import { getErrorMessage } from '@/utils/helpers';
import styles from './MetricsPage.module.scss';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'unconfigured' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; url: string; expiresAt: number; session: string };

export function MetricsPage() {
  const { t } = useTranslation();
  // The signed URL belongs to one signed-in connection; any change hides and replaces it.
  const session = useAuthStore((state) => (state.isAuthenticated ? state.apiBase : ''));
  const connected = session !== '';
  const [stored, setState] = useState<LoadState>({ kind: 'loading' });
  const [frameLoaded, setFrameLoaded] = useState(false);
  const requestRef = useRef(0);
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);

  const load = useCallback(async (forSession: string) => {
    const requestId = ++requestRef.current;
    setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));
    try {
      const embed = await metricsEmbedApi.get();
      if (requestId !== requestRef.current) return;
      if (!embed.configured) {
        setState({ kind: 'unconfigured' });
        return;
      }
      setFrameLoaded(false);
      setState({ kind: 'ready', url: embed.url, expiresAt: embed.expiresAt, session: forSession });
    } catch (err: unknown) {
      if (requestId !== requestRef.current) return;
      setState({
        kind: 'error',
        message: getErrorMessage(err, tRef.current('notification.refresh_failed')),
      });
    }
  }, []);

  useEffect(() => {
    if (!session) return;
    void load(session);
    return () => {
      requestRef.current += 1;
    };
  }, [session, load]);

  const state: LoadState =
    !session || (stored.kind === 'ready' && stored.session !== session)
      ? { kind: 'loading' }
      : stored;

  const expiresAt = state.kind === 'ready' ? state.expiresAt : 0;
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setTimeout(
      () => void load(session),
      metricsEmbedRefreshDelay(expiresAt, Date.now())
    );
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() >= expiresAt - 60_000) {
        void load(session);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [expiresAt, session, load]);

  const retry = (
    <Button variant="secondary" size="sm" onClick={() => void load(session)} disabled={!connected}>
      <IconRefreshCw size={14} aria-hidden="true" />
      {t('common.refresh')}
    </Button>
  );

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.headerCopy}>
          <h1 className={styles.title}>{t('metrics.title')}</h1>
          <p className={styles.description}>{t('metrics.description')}</p>
        </div>
        {state.kind === 'ready' ? retry : null}
      </header>

      {state.kind === 'loading' ? (
        <div role="status" aria-label={t('common.loading')}>
          <Skeleton className={styles.viewport} rounded={12} />
        </div>
      ) : state.kind === 'unconfigured' ? (
        <EmptyState
          title={t('metrics.not_configured_title')}
          description={t('metrics.not_configured_desc')}
        />
      ) : state.kind === 'error' ? (
        <Card>
          <EmptyState
            variant="error"
            title={t('metrics.load_failed')}
            description={state.message}
            action={retry}
          />
        </Card>
      ) : (
        <div className={styles.frameWrap} aria-busy={!frameLoaded}>
          {!frameLoaded ? <Skeleton className={styles.frameSkeleton} rounded={12} /> : null}
          <iframe
            key={state.url}
            className={styles.viewport}
            src={state.url}
            title={t('metrics.frame_title')}
            referrerPolicy="no-referrer"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
            onLoad={() => setFrameLoaded(true)}
          />
        </div>
      )}
    </div>
  );
}
