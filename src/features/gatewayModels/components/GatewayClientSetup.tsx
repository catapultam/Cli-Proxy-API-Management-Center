import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Collapsible } from '@/components/ui/Collapsible';
import { IconCopy } from '@/components/ui/icons';
import { useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import styles from '../GatewayModelsPage.module.scss';

export const INSTALL_COMMAND = 'claude plugin install gateway-models@homelab';
export const SETUP_COMMAND = '/gateway-models-setup';

function CommandLine({ command, copyLabel }: { command: string; copyLabel: string }) {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);

  const handleCopy = async () => {
    const copied = await copyToClipboard(command);
    showNotification(
      t(copied ? 'gateway_models.setup_copied' : 'notification.copy_failed'),
      copied ? 'success' : 'error'
    );
  };

  return (
    <div className={styles.commandLine}>
      <code className={styles.commandText}>{command}</code>
      <Button
        variant="ghost"
        size="sm"
        className={styles.commandCopy}
        onClick={() => void handleCopy()}
        title={copyLabel}
        aria-label={copyLabel}
      >
        <IconCopy size={14} aria-hidden="true" />
      </Button>
    </div>
  );
}

/** One-time client setup, collapsed so it stays out of the way of editing. */
export function GatewayClientSetup() {
  const { t } = useTranslation();
  return (
    <Collapsible
      className={styles.setup}
      label={t('gateway_models.setup_title')}
      hint={t('gateway_models.setup_hint')}
    >
      <div className={styles.setupBody}>
        <p className={styles.setupText}>{t('gateway_models.setup_requirement')}</p>
        <ol className={styles.setupSteps}>
          <li>
            <p className={styles.setupText}>{t('gateway_models.setup_step_install')}</p>
            <CommandLine
              command={INSTALL_COMMAND}
              copyLabel={t('gateway_models.setup_copy_install')}
            />
          </li>
          <li>
            <p className={styles.setupText}>{t('gateway_models.setup_step_setup')}</p>
            <CommandLine command={SETUP_COMMAND} copyLabel={t('gateway_models.setup_copy_setup')} />
          </li>
          <li>
            <p className={styles.setupText}>{t('gateway_models.setup_step_restart')}</p>
          </li>
        </ol>
      </div>
    </Collapsible>
  );
}
