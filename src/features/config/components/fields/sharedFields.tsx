// Single rendering source for the 8 high-frequency fields: SectionCommon (the "common"
// tab) and the canonical sections share these components, so the two renders cannot
// structurally drift (the old simple mode relied on shared JSX constants for the same
// purpose).
// Note: only the active tab is mounted, so FieldAnchor's DOM id is never duplicated.

import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
import type { VisualConfigValues } from '@/types/visualConfig';
import { ApiKeysCardEditor } from '../blocks/ApiKeysCardEditor';
import { FieldAnchor, FieldGroup, ToggleRow } from './FieldPrimitives';

export type SharedFieldProps = {
  values: VisualConfigValues;
  disabled: boolean;
  onChange: (patch: Partial<VisualConfigValues>) => void;
};

export function HostField({ values, disabled, onChange }: SharedFieldProps) {
  const { t } = useTranslation();
  return (
    <FieldAnchor fieldId="host">
      <Input
        label={t('config_management.visual.sections.server.host')}
        placeholder="0.0.0.0"
        value={values.host}
        onChange={(e) => onChange({ host: e.target.value })}
        disabled={disabled}
      />
    </FieldAnchor>
  );
}

export function PortField({
  values,
  disabled,
  onChange,
  error,
}: SharedFieldProps & { error?: string }) {
  const { t } = useTranslation();
  return (
    <FieldAnchor fieldId="port">
      <Input
        label={t('config_management.visual.sections.server.port')}
        type="number"
        placeholder="8317"
        value={values.port}
        onChange={(e) => onChange({ port: e.target.value })}
        disabled={disabled}
        error={error}
      />
    </FieldAnchor>
  );
}

export function ProxyUrlField({ values, disabled, onChange }: SharedFieldProps) {
  const { t } = useTranslation();
  // Proxy URL is long, so the field spans two columns.
  return (
    <FieldAnchor fieldId="proxyUrl" wide>
      <Input
        label={t('config_management.visual.sections.network.proxy_url')}
        placeholder="socks5://user:pass@127.0.0.1:1080/"
        value={values.proxyUrl}
        onChange={(e) => onChange({ proxyUrl: e.target.value })}
        disabled={disabled}
      />
    </FieldAnchor>
  );
}

export function ApiKeysField({ values, disabled, onChange }: SharedFieldProps) {
  return (
    <FieldAnchor fieldId="apiKeys">
      <FieldGroup>
        <ApiKeysCardEditor
          value={values.apiKeysText}
          disabled={disabled}
          onChange={(apiKeysText) => onChange({ apiKeysText })}
        />
      </FieldGroup>
    </FieldAnchor>
  );
}

export function DebugToggle({ values, disabled, onChange }: SharedFieldProps) {
  const { t } = useTranslation();
  return (
    <FieldAnchor fieldId="debug">
      <ToggleRow
        title={t('config_management.visual.sections.system.debug')}
        description={t('config_management.visual.sections.system.debug_desc')}
        checked={values.debug}
        disabled={disabled}
        onChange={(debug) => onChange({ debug })}
      />
    </FieldAnchor>
  );
}

export function LoggingToFileToggle({ values, disabled, onChange }: SharedFieldProps) {
  const { t } = useTranslation();
  return (
    <FieldAnchor fieldId="loggingToFile">
      <ToggleRow
        title={t('config_management.visual.sections.system.logging_to_file')}
        description={t('config_management.visual.sections.system.logging_to_file_desc')}
        checked={values.loggingToFile}
        disabled={disabled}
        onChange={(loggingToFile) => onChange({ loggingToFile })}
      />
    </FieldAnchor>
  );
}

export function QuotaSwitchProjectToggle({ values, disabled, onChange }: SharedFieldProps) {
  const { t } = useTranslation();
  return (
    <FieldAnchor fieldId="quotaSwitchProject">
      <ToggleRow
        title={t('config_management.visual.sections.quota.switch_project')}
        description={t('config_management.visual.sections.quota.switch_project_desc')}
        checked={values.quotaSwitchProject}
        disabled={disabled}
        onChange={(quotaSwitchProject) => onChange({ quotaSwitchProject })}
      />
    </FieldAnchor>
  );
}

export function QuotaSwitchPreviewModelToggle({ values, disabled, onChange }: SharedFieldProps) {
  const { t } = useTranslation();
  return (
    <FieldAnchor fieldId="quotaSwitchPreviewModel">
      <ToggleRow
        title={t('config_management.visual.sections.quota.switch_preview_model')}
        description={t('config_management.visual.sections.quota.switch_preview_model_desc')}
        checked={values.quotaSwitchPreviewModel}
        disabled={disabled}
        onChange={(quotaSwitchPreviewModel) => onChange({ quotaSwitchPreviewModel })}
      />
    </FieldAnchor>
  );
}
