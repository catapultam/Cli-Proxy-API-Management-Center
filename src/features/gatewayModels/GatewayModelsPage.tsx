import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconInfo, IconPlus, IconRefreshCw } from '@/components/ui/icons';
import { Skeleton } from '@/components/ui/Skeleton';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { gatewayModelsApi } from '@/services/api/gatewayModels';
import { guardConfigConnection } from '@/services/api/configValue';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import { getErrorMessage } from '@/utils/helpers';
import { GatewayClientSetup } from './components/GatewayClientSetup';
import { GatewayModelRow, type GatewayDraftPatch } from './components/GatewayModelRow';
import {
  MAX_ROWS,
  buildEmptyDraft,
  countErrors,
  getDraftsSignature,
  toDrafts,
  toEntries,
  validateDrafts,
  type GatewayDraftErrors,
  type GatewayModelDraft,
} from './logic';
import styles from './GatewayModelsPage.module.scss';

type LoadState = 'loading' | 'ready' | 'error';

/** Required-field errors stay quiet until the first save attempt. */
const visibleErrors = (errors: GatewayDraftErrors, showRequired: boolean): GatewayDraftErrors =>
  Object.fromEntries(
    Object.entries(errors).filter(([, error]) => showRequired || !error?.required)
  ) as GatewayDraftErrors;

export function GatewayModelsPage() {
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const disableControls = connectionStatus !== 'connected';

  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState('');
  const [drafts, setDrafts] = useState<GatewayModelDraft[]>([]);
  const [baseline, setBaseline] = useState('[]');
  const [saving, setSaving] = useState(false);
  const [showRequired, setShowRequired] = useState(false);
  const loadRequestRef = useRef(0);
  // Keep load identity stable across language switches; a new load would discard edits.
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const assertConnectionRef = useRef<(() => void) | null>(null);

  const load = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setLoadState('loading');
    setLoadError('');
    setShowRequired(false);
    const assertConnection = guardConfigConnection();
    try {
      const entries = await gatewayModelsApi.list();
      if (requestId !== loadRequestRef.current) return;
      const next = toDrafts(entries);
      assertConnectionRef.current = assertConnection;
      setDrafts(next);
      setBaseline(getDraftsSignature(next));
      setLoadState('ready');
    } catch (err: unknown) {
      if (requestId !== loadRequestRef.current) return;
      assertConnectionRef.current = null;
      setDrafts([]);
      setLoadError(getErrorMessage(err, tRef.current('notification.refresh_failed')));
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [load]);

  const signature = useMemo(() => getDraftsSignature(drafts), [drafts]);
  const isDirty = loadState === 'ready' && signature !== baseline;
  const errors = useMemo(() => validateDrafts(drafts), [drafts]);
  const errorCount = countErrors(errors);

  const unsavedChangesDialog = useMemo(
    () => ({
      title: t('common.unsaved_changes_title'),
      message: t('common.unsaved_changes_message'),
      confirmText: t('common.leave'),
      cancelText: t('common.stay'),
    }),
    [t]
  );
  useUnsavedChangesGuard({ shouldBlock: isDirty && !saving, dialog: unsavedChangesDialog });

  useEffect(() => {
    if (!isDirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  const updateDraft = useCallback((key: string, patch: GatewayDraftPatch) => {
    setDrafts((prev) => prev.map((draft) => (draft.key === key ? { ...draft, ...patch } : draft)));
  }, []);

  const addDraft = useCallback(() => {
    setDrafts((prev) => (prev.length >= MAX_ROWS ? prev : [...prev, buildEmptyDraft()]));
  }, []);

  const removeDraft = useCallback((key: string) => {
    setDrafts((prev) => prev.filter((draft) => draft.key !== key));
  }, []);

  const handleRefresh = useCallback(() => {
    if (!isDirty) {
      void load();
      return;
    }
    showConfirmation({
      title: t('gateway_models.discard_title'),
      message: t('gateway_models.discard_message'),
      confirmText: t('gateway_models.discard_confirm'),
      cancelText: t('common.stay'),
      variant: 'danger',
      onConfirm: () => void load(),
    });
  }, [isDirty, load, showConfirmation, t]);

  const canSave = loadState === 'ready' && !disableControls && !saving && isDirty;

  const handleSave = useCallback(async () => {
    if (!canSave) return;
    setShowRequired(true);
    if (countErrors(validateDrafts(drafts)) > 0) {
      showNotification(t('gateway_models.fix_errors'), 'error');
      return;
    }
    setSaving(true);
    try {
      assertConnectionRef.current?.();
      await gatewayModelsApi.replace(toEntries(drafts));
      // The config document changed under the cached copy.
      useConfigStore.getState().clearCache();
      setBaseline(getDraftsSignature(drafts));
      setShowRequired(false);
      showNotification(t('gateway_models.save_success'), 'success');
    } catch (err: unknown) {
      showNotification(
        `${t('gateway_models.save_failed')}: ${getErrorMessage(err)}`.replace(/: $/, ''),
        'error'
      );
    } finally {
      setSaving(false);
    }
  }, [canSave, drafts, showNotification, t]);

  const statusText = saving
    ? t('gateway_models.status_saving')
    : isDirty
      ? errorCount > 0 && showRequired
        ? t('gateway_models.status_errors', { count: errorCount })
        : t('gateway_models.status_unsaved')
      : t('gateway_models.status_saved');

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div className={styles.headerCopy}>
          <h1 className={styles.title}>{t('gateway_models.title')}</h1>
          <p className={styles.description}>{t('gateway_models.description')}</p>
        </div>
        <div className={styles.headerActions}>
          {loadState === 'ready' ? (
            <span
              className={`${styles.status} ${isDirty ? styles.statusDirty : ''}`}
              role="status"
              aria-live="polite"
            >
              {statusText}
            </span>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            onClick={handleRefresh}
            disabled={loadState === 'loading' || saving || disableControls}
          >
            <IconRefreshCw size={14} aria-hidden="true" />
            {t('common.refresh')}
          </Button>
          <Button size="sm" onClick={() => void handleSave()} loading={saving} disabled={!canSave}>
            {t('gateway_models.save')}
          </Button>
        </div>
      </header>

      <div className={styles.syncNote}>
        <IconInfo size={15} aria-hidden="true" />
        <p>{t('gateway_models.sync_note')}</p>
      </div>

      <GatewayClientSetup />

      {loadState === 'loading' ? (
        <div className={styles.list} role="status" aria-label={t('common.loading')}>
          <Skeleton height={210} rounded={12} />
          <Skeleton height={210} rounded={12} />
        </div>
      ) : loadState === 'error' ? (
        <Card>
          <EmptyState
            variant="error"
            title={t('gateway_models.load_failed')}
            description={loadError}
            action={
              <Button variant="secondary" size="sm" onClick={() => void load()}>
                {t('common.refresh')}
              </Button>
            }
          />
        </Card>
      ) : drafts.length === 0 ? (
        <EmptyState
          title={t('gateway_models.empty_title')}
          description={t('gateway_models.empty_desc')}
          action={
            <Button size="sm" onClick={addDraft} disabled={disableControls || saving}>
              <IconPlus size={14} aria-hidden="true" />
              {t('gateway_models.add_row')}
            </Button>
          }
        />
      ) : (
        <>
          <div className={styles.list}>
            {drafts.map((draft, index) => (
              <GatewayModelRow
                key={draft.key}
                draft={draft}
                index={index}
                errors={visibleErrors(errors[index], showRequired)}
                disabled={disableControls || saving}
                onChange={(patch) => updateDraft(draft.key, patch)}
                onRemove={() => removeDraft(draft.key)}
              />
            ))}
          </div>
          <div className={styles.listFooter}>
            <Button
              variant="secondary"
              size="sm"
              onClick={addDraft}
              disabled={disableControls || saving || drafts.length >= MAX_ROWS}
            >
              <IconPlus size={14} aria-hidden="true" />
              {t('gateway_models.add_row')}
            </Button>
            <span className={styles.count}>
              {t('gateway_models.row_count', { count: drafts.length, max: MAX_ROWS })}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
