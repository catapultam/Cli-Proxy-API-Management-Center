import { useEffect, useRef, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { prefersReducedMotion } from '@/hooks/motion';
import {
  CONFIG_TAB_ICONS,
  CONFIG_TAB_IDS,
  configPanelDomId,
  configTabDomId,
  type ConfigTabId,
} from '../constants';
import { computeConfigTabsFade } from './configTabsFade';
import styles from './ConfigTabs.module.scss';

export type ConfigTabsProps = {
  active: ConfigTabId;
  /** 每 tab 校验错误数（uiState.countSectionErrors 的产物），>0 显示失败色徽章。 */
  errorCounts: Partial<Record<ConfigTabId, number>>;
  /** 有待保存修改的 tabs（uiState.resolveDirtyTabs 的产物），显示琥珀脏点。 */
  dirtyTabs: ReadonlySet<ConfigTabId>;
  disabled?: boolean;
  onChange: (id: ConfigTabId) => void;
};

/**
 * 分区 tabs：安静的下划线式（与提供商 tabs 同语汇），图标 + 标签 + 错误徽章 + 脏点。
 * 「常用」是首 tab；tab 切换是高频操作，零动画。
 */
export function ConfigTabs({
  active,
  errorCounts,
  dirtyTabs,
  disabled = false,
  onChange,
}: ConfigTabsProps) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLDivElement | null>(null);
  const buttonRefs = useRef<Partial<Record<ConfigTabId, HTMLButtonElement | null>>>({});

  // 移动端横滚时把激活 tab 带回视野中央；无溢出时不动，避免无谓的页面滚动。
  useEffect(() => {
    const scroller = listRef.current;
    const button = buttonRefs.current[active];
    if (!scroller || !button) return;
    if (scroller.scrollWidth <= scroller.clientWidth) return;
    button.scrollIntoView({
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'nearest',
      inline: 'center',
    });
  }, [active]);

  // The edge mask only fades the side that still has tabs to scroll toward; at
  // scrollLeft 0 (or at the end) that side's fade — and the focus ring it would
  // otherwise dim, e.g. the active first tab — stays off. Attributes (not React
  // state) because this runs on every scroll frame and must not force a re-render.
  useEffect(() => {
    const scroller = listRef.current;
    if (!scroller) return;
    const update = () => {
      const { fadeStart, fadeEnd } = computeConfigTabsFade(scroller);
      scroller.toggleAttribute('data-fade-start', fadeStart);
      scroller.toggleAttribute('data-fade-end', fadeEnd);
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    // Observe the tab buttons themselves, not just the scroller: a language switch
    // (or a font finishing its load) changes each button's own width, which changes
    // `scrollWidth` without necessarily changing the scroller's own border-box size
    // (it's a `flex: 1` child, sized by its flex container, not by its content) — a
    // ResizeObserver on the scroller alone would miss that and leave the fade stale.
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(scroller);
    for (const button of Object.values(buttonRefs.current)) {
      if (button) resizeObserver.observe(button);
    }
    return () => {
      scroller.removeEventListener('scroll', update);
      resizeObserver.disconnect();
    };
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const count = CONFIG_TAB_IDS.length;
    const currentIndex = CONFIG_TAB_IDS.indexOf(active);
    let nextIndex = -1;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % count;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + count) % count;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = count - 1;
    if (nextIndex < 0) return;
    event.preventDefault();
    const nextId = CONFIG_TAB_IDS[nextIndex];
    onChange(nextId);
    buttonRefs.current[nextId]?.focus();
  };

  return (
    <div
      className={styles.tabs}
      role="tablist"
      aria-label={t('config_management.title')}
      ref={listRef}
    >
      {CONFIG_TAB_IDS.map((id) => {
        const Icon = CONFIG_TAB_ICONS[id];
        const isActive = active === id;
        const errorCount = errorCounts[id] ?? 0;
        const isDirty = dirtyTabs.has(id);
        const tabLabel = t(`config_management.visual.sections.${id}.title`);
        const accessibleLabel = [
          tabLabel,
          errorCount > 0 ? t('config_management.meta_errors', { count: errorCount }) : null,
          isDirty ? t('config_management.status_dirty_short') : null,
        ]
          .filter(Boolean)
          .join(', ');

        return (
          <button
            key={id}
            ref={(node) => {
              buttonRefs.current[id] = node;
            }}
            type="button"
            role="tab"
            id={configTabDomId(id)}
            aria-selected={isActive}
            aria-controls={configPanelDomId(id)}
            aria-label={accessibleLabel}
            tabIndex={isActive ? 0 : -1}
            className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
            disabled={disabled}
            onClick={() => onChange(id)}
            onKeyDown={handleKeyDown}
          >
            <Icon size={15} className={styles.tabGlyph} />
            <span className={styles.tabLabel}>{tabLabel}</span>
            {errorCount > 0 ? (
              <span className={styles.tabBadge} aria-hidden="true">
                {errorCount}
              </span>
            ) : null}
            {isDirty ? <span className={styles.tabDirtyDot} aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}
