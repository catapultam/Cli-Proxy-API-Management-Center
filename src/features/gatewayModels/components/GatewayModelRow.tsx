import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { AutocompleteInput } from '@/components/ui/AutocompleteInput';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { IconTrash2 } from '@/components/ui/icons';
import { GATEWAY_EFFORT_LEVELS } from '@/services/api/gatewayModels';
import {
  BEHAVES_AS_OPTIONS,
  getClientModelId,
  type GatewayDraftErrors,
  type GatewayField,
  type GatewayFieldError,
  type GatewayModelDraft,
} from '../logic';
import styles from '../GatewayModelsPage.module.scss';

export type GatewayDraftPatch = Partial<Omit<GatewayModelDraft, 'key' | 'extra'>>;

interface GatewayModelRowProps {
  draft: GatewayModelDraft;
  index: number;
  /** Errors to display; required-field errors are filtered out by the caller until a save attempt. */
  errors: GatewayDraftErrors;
  disabled: boolean;
  onChange: (patch: GatewayDraftPatch) => void;
  onRemove: () => void;
}

export function GatewayModelRow({
  draft,
  index,
  errors,
  disabled,
  onChange,
  onRemove,
}: GatewayModelRowProps) {
  const { t } = useTranslation();
  const id = useId();
  const number = index + 1;
  const clientId = getClientModelId(draft.id);

  const message = (field: GatewayField): string | undefined => {
    const error: GatewayFieldError | undefined = errors[field];
    return error ? t(`gateway_models.${error.code}`, error.params) : undefined;
  };

  const effortOptions = [
    { value: '', label: t('gateway_models.effort_inherit') },
    ...GATEWAY_EFFORT_LEVELS.map((level) => ({
      value: level,
      label: t(`gateway_models.effort_${level}`),
    })),
  ];

  return (
    <div className={styles.row} role="group" aria-label={t('gateway_models.row_label', { number })}>
      <div className={styles.rowHead}>
        <span className={styles.rowNumber} aria-hidden="true">
          {String(number).padStart(2, '0')}
        </span>
        <p className={styles.clientId}>
          <span className={styles.clientIdLabel}>{t('gateway_models.client_id')}</span>
          {clientId ? (
            <code className={styles.clientIdValue}>{clientId}</code>
          ) : (
            <span className={styles.clientIdEmpty}>{t('gateway_models.client_id_empty')}</span>
          )}
        </p>
        <Button
          variant="ghost"
          size="sm"
          className={styles.removeRow}
          onClick={onRemove}
          disabled={disabled}
          title={t('gateway_models.remove_row', { number })}
          aria-label={t('gateway_models.remove_row', { number })}
        >
          <IconTrash2 size={15} aria-hidden="true" />
        </Button>
      </div>

      <div className={styles.fields}>
        <Input
          id={`${id}-id`}
          label={t('gateway_models.field_id')}
          className={styles.mono}
          placeholder={t('gateway_models.field_id_placeholder')}
          value={draft.id}
          onChange={(event) => onChange({ id: event.target.value })}
          disabled={disabled}
          error={message('id')}
          autoComplete="off"
          spellCheck={false}
        />
        <Input
          id={`${id}-label`}
          label={t('gateway_models.field_label')}
          placeholder={t('gateway_models.field_label_placeholder')}
          value={draft.label}
          onChange={(event) => onChange({ label: event.target.value })}
          disabled={disabled}
          error={message('label')}
          autoComplete="off"
        />
        <AutocompleteInput
          id={`${id}-behaves`}
          label={t('gateway_models.field_behaves_as')}
          className={styles.mono}
          value={draft.behavesAs}
          onChange={(value) => onChange({ behavesAs: value })}
          options={[...BEHAVES_AS_OPTIONS]}
          disabled={disabled}
          error={message('behavesAs')}
        />
        <Input
          id={`${id}-compact`}
          label={t('gateway_models.field_compact')}
          className={styles.mono}
          inputMode="numeric"
          placeholder={t('gateway_models.field_compact_placeholder')}
          value={draft.autoCompactWindow}
          onChange={(event) => onChange({ autoCompactWindow: event.target.value })}
          disabled={disabled}
          error={message('autoCompactWindow')}
          autoComplete="off"
        />
        <div className="form-group">
          <label id={`${id}-effort-label`}>{t('gateway_models.field_effort')}</label>
          <Select
            id={`${id}-effort`}
            ariaLabelledBy={`${id}-effort-label`}
            fullWidth
            value={draft.effortLevel}
            options={effortOptions}
            onChange={(value) =>
              onChange({ effortLevel: value as GatewayModelDraft['effortLevel'] })
            }
            disabled={disabled}
          />
        </div>
        <div className={styles.hideField}>
          <SelectionCheckbox
            checked={draft.hideFromDiscovery}
            onChange={(value) => onChange({ hideFromDiscovery: value })}
            disabled={disabled}
            label={
              <>
                <span className={styles.hideTitle}>{t('gateway_models.field_hide')}</span>
                <span className={styles.hideHint}>{t('gateway_models.field_hide_hint')}</span>
              </>
            }
          />
        </div>
      </div>
    </div>
  );
}
