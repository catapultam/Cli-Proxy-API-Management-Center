// Single rendering source for the 8 high-frequency fields: SectionCommon (the "common"
// tab) and the canonical sections share these components, so the two renders cannot
// structurally drift (the old simple mode relied on shared JSX constants for the same
// purpose).
// Note: only the active tab is mounted, so FieldAnchor's DOM id is never duplicated.

import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { Input } from '@/components/ui/Input';
import type { VisualConfigValues } from '@/types/visualConfig';
import { SPONSORS } from '../../sponsors';
import { ApiKeysCardEditor } from '../blocks/ApiKeysCardEditor';
import { FieldAnchor, FieldGroup, ToggleRow } from './FieldPrimitives';
import fieldStyles from './Field.module.scss';

export type SharedFieldProps = {
  values: VisualConfigValues;
  disabled: boolean;
  onChange: (patch: Partial<VisualConfigValues>) => void;
  /**
   * Optional placeholder row under the label (see SponsorHintSpacer), passed only when
   * this field needs to line up with the Proxy URL field's sponsor hint row. Forwarded
   * directly to Input's labelExtra — this is what lets same-row fields' label rows and
   * input rows both align (not just the inputs).
   */
  labelExtra?: ReactNode;
};

export function HostField({ values, disabled, onChange, labelExtra }: SharedFieldProps) {
  const { t } = useTranslation();
  return (
    <FieldAnchor fieldId="host">
      <Input
        label={t('config_management.visual.sections.server.host')}
        placeholder="0.0.0.0"
        value={values.host}
        onChange={(e) => onChange({ host: e.target.value })}
        disabled={disabled}
        labelExtra={labelExtra}
      />
    </FieldAnchor>
  );
}

export function PortField({
  values,
  disabled,
  onChange,
  error,
  labelExtra,
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
        labelExtra={labelExtra}
      />
    </FieldAnchor>
  );
}

export function ProxyUrlField({ values, disabled, onChange }: SharedFieldProps) {
  const { t } = useTranslation();
  // Proxy URL is long, so the field spans two columns; a sponsor link row hangs under
  // the label (data in sponsors.ts — doesn't render when empty).
  const sponsor = SPONSORS[0];
  return (
    <FieldAnchor fieldId="proxyUrl" wide>
      <Input
        label={t('config_management.visual.sections.network.proxy_url')}
        labelExtra={
          sponsor ? (
            <p className={fieldStyles.fieldSponsorHint}>
              {t('config_management.visual.sections.network.proxy_url_sponsor_hint')}
              <a
                className={fieldStyles.fieldSponsorLink}
                href={sponsor.url}
                target="_blank"
                rel="noopener noreferrer sponsored"
              >
                {sponsor.logo ? (
                  <img className={fieldStyles.fieldSponsorLogo} src={sponsor.logo} alt="" />
                ) : null}
                {sponsor.name}
              </a>
            </p>
          ) : undefined
        }
        placeholder="socks5://user:pass@127.0.0.1:1080/"
        value={values.proxyUrl}
        onChange={(e) => onChange({ proxyUrl: e.target.value })}
        disabled={disabled}
      />
    </FieldAnchor>
  );
}

/**
 * Invisible placeholder row for a field that shares a grid row with the Proxy URL
 * field: rendered under the label, above the input (Input's labelExtra), at the same
 * position and height as ProxyUrlField's sponsor hint row, so that same-row fields'
 * label rows and input rows both align — not just the inputs. Doesn't render when
 * there's no sponsor.
 *
 * `minTracks` is the minimum number of grid-column tracks that must fit in a row for
 * the sponsor field (Proxy URL, which spans the first 2 tracks) to still be sharing
 * that row once this field's own track is accounted for. FieldGrid's auto-fit column
 * count depends on container width, so this field only actually shares a row with the
 * sponsor at widths wide enough to fit that many tracks — the `data-min-tracks`
 * attribute lets Field.module.scss show the placeholder only then (see the
 * `@container` rules next to `.fieldSponsorSpacer`).
 */
export function SponsorHintSpacer({ minTracks }: { minTracks: number }) {
  if (SPONSORS.length === 0) return null;
  return (
    <p
      className={fieldStyles.fieldSponsorSpacer}
      aria-hidden="true"
      data-min-tracks={minTracks}
    >
      &nbsp;
    </p>
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
