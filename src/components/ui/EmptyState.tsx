import type { ReactNode } from 'react';
import { IconAlertTriangle, IconInbox } from './icons';

interface EmptyStateProps {
  title: string;
  description?: string;
  action?: ReactNode;
  /**
   * 'card' (default): the full card treatment for when this owns the page's main
   * content area (icon circle + dashed border).
   * 'quiet': used when already inside a bordered card/panel — doesn't draw a second
   * dashed border (nested cards are an anti-pattern). Plain text; the title still
   * reads as a heading (weight 600, primary text) over the description below it.
   * 'error': same nested, borderless layout as 'quiet', for when the empty state is
   * actually a load failure — it must read as an error, not as a calm empty list.
   */
  variant?: 'card' | 'quiet' | 'error';
}

export function EmptyState({ title, description, action, variant = 'card' }: EmptyStateProps) {
  const nested = variant !== 'card';
  const isError = variant === 'error';
  return (
    <div className={nested ? `empty-state empty-state--${variant}` : 'empty-state'}>
      <div className="empty-content">
        {!nested && (
          <div className="empty-icon" aria-hidden="true">
            <IconInbox size={20} />
          </div>
        )}
        {isError && (
          <div className="empty-icon" aria-hidden="true">
            <IconAlertTriangle size={20} />
          </div>
        )}
        <div>
          <div className="empty-title">{title}</div>
          {description && <div className="empty-desc">{description}</div>}
        </div>
      </div>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}
