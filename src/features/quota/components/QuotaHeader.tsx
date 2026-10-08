import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { IconRefreshCw } from '@/components/ui/icons';
import { Select } from '@/components/ui/Select';
import { useCountUp } from '@/hooks/motion';
import {
  QUOTA_AUTO_REFRESH_LABEL_KEYS,
  QUOTA_AUTO_REFRESH_OPTIONS,
  type QuotaAutoRefreshMs,
} from '../constants';
import styles from './QuotaHeader.module.scss';

export type QuotaHeaderProps = {
  totalCount: number;
  loadedCount: number;
  attentionCount: number;
  refreshing: boolean;
  disableControls: boolean;
  onRefreshAll: () => void;
  autoRefreshMs: QuotaAutoRefreshMs;
  onAutoRefreshChange: (value: QuotaAutoRefreshMs) => void;
};

/**
 * 额度页头部：标题领衔 + ▍mono 遥测 meta 行 + 墨色药丸「刷新全部」。
 * 与凭证库头部同语汇（无 eyebrow —— ▍游标挂在 meta 行开头）。
 *
 * 入场：三处 `data-reveal` 交给页面壳的 useRevealGroup 统一编排
 * （标题 0ms → meta 70ms → 动作 140ms → tabs 210ms）。
 *
 * The auto-refresh interval select sits next to "Refresh all"; the actual
 * scheduling lives in useQuotaAutoRefresh (see QuotaPage) — this component
 * only renders the control and reports the chosen interval upward.
 */
export function QuotaHeader(props: QuotaHeaderProps) {
  const {
    totalCount,
    loadedCount,
    attentionCount,
    refreshing,
    disableControls,
    onRefreshAll,
    autoRefreshMs,
    onAutoRefreshChange,
  } = props;
  const { t } = useTranslation();
  // 批量结果陆续落地时，「已加载」是页面上唯一滚动的数字
  const displayLoadedCount = useCountUp(loadedCount);

  const autoRefreshOptions = useMemo(
    () =>
      QUOTA_AUTO_REFRESH_OPTIONS.map((ms) => ({
        value: String(ms),
        label: t(`quota_management.auto_refresh_${QUOTA_AUTO_REFRESH_LABEL_KEYS[ms]}`),
      })),
    [t]
  );

  const handleAutoRefreshChange = (next: string) => {
    const parsed = Number(next);
    const match = QUOTA_AUTO_REFRESH_OPTIONS.find((ms) => ms === parsed);
    onAutoRefreshChange(match ?? QUOTA_AUTO_REFRESH_OPTIONS[0]);
  };

  return (
    <header className={styles.header}>
      <div className={styles.copy}>
        <h1 className={styles.title} data-reveal>
          {t('quota_management.title')}
        </h1>
        <p className={styles.meta} data-reveal>
          <span className={styles.metaTotal}>
            {t('quota_management.meta_credentials', { count: totalCount })}
          </span>
          <span className={styles.metaDot} aria-hidden="true">
            ·
          </span>
          <span className={loadedCount > 0 ? styles.metaLoaded : styles.metaMuted}>
            {t('quota_management.meta_loaded', { count: displayLoadedCount })}
          </span>
          {attentionCount > 0 && (
            <>
              <span className={styles.metaDot} aria-hidden="true">
                ·
              </span>
              <span className={styles.metaAttention}>
                {t('quota_management.meta_attention', { count: attentionCount })}
              </span>
            </>
          )}
        </p>
      </div>
      <div className={styles.actions} data-reveal>
        <div className={styles.autoRefresh}>
          <span className={styles.autoRefreshLabel} aria-hidden="true">
            {t('quota_management.auto_refresh_label')}
          </span>
          <Select
            value={String(autoRefreshMs)}
            options={autoRefreshOptions}
            onChange={handleAutoRefreshChange}
            ariaLabel={t('quota_management.auto_refresh_label')}
            disabled={disableControls}
            size="sm"
            fullWidth={false}
          />
        </div>
        <button
          type="button"
          className={styles.primaryAction}
          onClick={onRefreshAll}
          disabled={disableControls || refreshing}
        >
          <IconRefreshCw size={14} className={refreshing ? styles.spinning : undefined} />
          {t('quota_management.refresh_all_credentials')}
        </button>
      </div>
    </header>
  );
}
