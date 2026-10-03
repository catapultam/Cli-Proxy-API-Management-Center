import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { IconEye, IconEyeOff, IconTrash2 } from '@/components/ui/icons';
import { useAuthStore, useNotificationStore } from '@/stores';
import { accountApi } from '@/services/api/account';
import {
  creationOptionsFromJSON,
  credentialToJSON,
  guessDeviceName,
  supportsPasskeys,
} from '@/services/passkey';
import { getErrorMessage } from '@/utils/helpers';
import { formatDateTimeValue } from '@/utils/format';
import type { AccountPasskey, AccountView } from '@/types';
import styles from './AccountPage.module.scss';

const MIN_PASSWORD_LENGTH = 12;

export function AccountPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { showNotification, showConfirmation } = useNotificationStore();
  const authMode = useAuthStore((state) => state.authMode);
  const apiBase = useAuthStore((state) => state.apiBase);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const applySessionLogin = useAuthStore((state) => state.applySessionLogin);
  const logout = useAuthStore((state) => state.logout);

  const [account, setAccount] = useState<AccountView | null>(null);
  const [loadingAccount, setLoadingAccount] = useState(true);
  const [loadError, setLoadError] = useState('');

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showCurrentPassword, setShowCurrentPassword] = useState(false);
  const [savingAccount, setSavingAccount] = useState(false);

  const [rpId, setRpId] = useState('');
  const [originsText, setOriginsText] = useState('');
  const [savingPasskeySettings, setSavingPasskeySettings] = useState(false);

  const [addingPasskey, setAddingPasskey] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [signingOutAll, setSigningOutAll] = useState(false);

  const requiresCurrentPassword = authMode === 'session' && Boolean(account?.configured);

  const loadAccount = useCallback(async () => {
    setLoadingAccount(true);
    setLoadError('');
    try {
      const data = await accountApi.get();
      setAccount(data);
      setUsername(data.username || '');
      setRpId(
        data.passkey_rp_id || (typeof window !== 'undefined' ? window.location.hostname : '')
      );
      setOriginsText(
        (data.passkey_origins && data.passkey_origins.length > 0
          ? data.passkey_origins
          : typeof window !== 'undefined'
            ? [window.location.origin]
            : []
        ).join('\n')
      );
    } catch (err: unknown) {
      setLoadError(getErrorMessage(err) || t('account.load_error'));
    } finally {
      setLoadingAccount(false);
    }
  }, [t]);

  useEffect(() => {
    if (connectionStatus === 'connected') {
      void loadAccount();
    }
  }, [connectionStatus, loadAccount]);

  const passwordHint = useMemo(
    () => t('account.password_hint', { count: MIN_PASSWORD_LENGTH }),
    [t]
  );

  const handleSaveAccount = useCallback(async () => {
    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      showNotification(t('account.error_username_required'), 'error');
      return;
    }
    if (password && password.length < MIN_PASSWORD_LENGTH) {
      showNotification(passwordHint, 'error');
      return;
    }
    if (!account?.configured && !password) {
      showNotification(t('account.error_password_required'), 'error');
      return;
    }
    if (requiresCurrentPassword && account?.configured && password && !currentPassword) {
      showNotification(t('account.error_current_password_required'), 'error');
      return;
    }

    setSavingAccount(true);
    try {
      const response = await accountApi.save({
        username: trimmedUsername,
        password,
        ...(requiresCurrentPassword && currentPassword
          ? { current_password: currentPassword }
          : {}),
      });
      applySessionLogin(apiBase, response, 'password');
      setAccount((prev) =>
        prev ? { ...prev, configured: true, username: trimmedUsername } : prev
      );
      setPassword('');
      setCurrentPassword('');
      showNotification(t('account.account_saved'), 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      showNotification(
        `${t('account.account_save_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      setSavingAccount(false);
    }
  }, [
    account?.configured,
    apiBase,
    applySessionLogin,
    currentPassword,
    password,
    passwordHint,
    requiresCurrentPassword,
    showNotification,
    t,
    username,
  ]);

  const handleSavePasskeySettings = useCallback(async () => {
    const origins = originsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    setSavingPasskeySettings(true);
    try {
      const data = await accountApi.savePasskeySettings({ rp_id: rpId.trim(), origins });
      setAccount(data);
      showNotification(t('account.passkey_settings_saved'), 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      showNotification(
        `${t('account.passkey_settings_save_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      setSavingPasskeySettings(false);
    }
  }, [originsText, rpId, showNotification, t]);

  const handleAddPasskey = useCallback(async () => {
    if (typeof window === 'undefined') return;
    const suggested = guessDeviceName(navigator.userAgent);
    const name = window.prompt(t('account.passkey_name_prompt'), suggested);
    if (!name) return;

    setAddingPasskey(true);
    try {
      const begin = await accountApi.passkeysBegin();
      const options = creationOptionsFromJSON(
        begin.options as { publicKey: Record<string, unknown> }
      );
      const credential = await navigator.credentials.create(options);
      if (!credential) throw new Error('No credential returned');
      const credentialJSON = credentialToJSON(credential as PublicKeyCredential);
      const passkey = await accountApi.passkeysFinish({
        ceremony_id: begin.ceremony_id,
        name,
        credential: credentialJSON,
      });
      setAccount((prev) => (prev ? { ...prev, passkeys: [...prev.passkeys, passkey] } : prev));
      showNotification(t('account.passkey_added'), 'success');
    } catch (err: unknown) {
      if (
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'AbortError')
      ) {
        return;
      }
      const message = getErrorMessage(err);
      showNotification(
        `${t('account.passkey_add_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
    } finally {
      setAddingPasskey(false);
    }
  }, [showNotification, t]);

  const handleRenamePasskey = useCallback(
    async (passkey: AccountPasskey) => {
      if (typeof window === 'undefined') return;
      const name = window.prompt(t('account.passkey_name_prompt'), passkey.name);
      if (!name || name === passkey.name) return;

      setRenamingId(passkey.id);
      try {
        const updated = await accountApi.renamePasskey(passkey.id, name);
        setAccount((prev) =>
          prev
            ? { ...prev, passkeys: prev.passkeys.map((p) => (p.id === updated.id ? updated : p)) }
            : prev
        );
        showNotification(t('account.passkey_renamed'), 'success');
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        showNotification(
          `${t('account.passkey_rename_failed')}${message ? `: ${message}` : ''}`,
          'error'
        );
      } finally {
        setRenamingId(null);
      }
    },
    [showNotification, t]
  );

  const handleDeletePasskey = useCallback(
    (passkey: AccountPasskey) => {
      showConfirmation({
        title: t('account.passkey_delete_title'),
        message: t('account.passkey_delete_confirm', { name: passkey.name }),
        variant: 'danger',
        confirmText: t('common.delete'),
        onConfirm: async () => {
          setDeletingId(passkey.id);
          try {
            await accountApi.deletePasskey(passkey.id);
            setAccount((prev) =>
              prev ? { ...prev, passkeys: prev.passkeys.filter((p) => p.id !== passkey.id) } : prev
            );
            showNotification(t('account.passkey_deleted'), 'success');
          } catch (err: unknown) {
            const message = getErrorMessage(err);
            showNotification(
              `${t('account.passkey_delete_failed')}${message ? `: ${message}` : ''}`,
              'error'
            );
          } finally {
            setDeletingId(null);
          }
        },
      });
    },
    [showConfirmation, showNotification, t]
  );

  const handleSignOutAll = useCallback(() => {
    showConfirmation({
      title: t('account.sign_out_all_title'),
      message: t('account.sign_out_all_confirm'),
      variant: 'danger',
      confirmText: t('account.sign_out_all_button'),
      onConfirm: async () => {
        setSigningOutAll(true);
        try {
          await accountApi.signOutAll();
          showNotification(t('account.signed_out_all'), 'success');
          await logout();
          navigate('/login', { replace: true });
        } catch (err: unknown) {
          const message = getErrorMessage(err);
          showNotification(
            `${t('account.sign_out_all_failed')}${message ? `: ${message}` : ''}`,
            'error'
          );
        } finally {
          setSigningOutAll(false);
        }
      },
    });
  }, [logout, navigate, showConfirmation, showNotification, t]);

  const passkeysAvailable = Boolean(account?.passkey_rp_id) && account?.configured;
  const canAddPasskey = passkeysAvailable && supportsPasskeys();

  return (
    <div className={styles.container}>
      <h1 className={styles.pageTitle}>{t('account.title')}</h1>
      <div className={styles.content}>
        {loadError && <div className="error-box">{loadError}</div>}

        <Card title={t('account.credentials_title')}>
          <p className={styles.sectionDescription}>
            {account?.configured
              ? t('account.credentials_desc_change')
              : t('account.credentials_desc_setup')}
          </p>
          {loadingAccount ? (
            <div className="hint">{t('common.loading')}</div>
          ) : (
            <div className={styles.formRow}>
              <Input
                label={t('account.username_label')}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
              />
              {requiresCurrentPassword && (
                <Input
                  label={t('account.current_password_label')}
                  type={showCurrentPassword ? 'text' : 'password'}
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  autoComplete="current-password"
                  rightElement={
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setShowCurrentPassword((prev) => !prev)}
                      aria-label={showCurrentPassword ? t('login.hide_key') : t('login.show_key')}
                    >
                      {showCurrentPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                    </button>
                  }
                />
              )}
              <Input
                label={
                  account?.configured
                    ? t('account.new_password_label')
                    : t('account.password_label')
                }
                hint={passwordHint}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                rightElement={
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setShowPassword((prev) => !prev)}
                    aria-label={showPassword ? t('login.hide_key') : t('login.show_key')}
                  >
                    {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                  </button>
                }
              />
              <div className={styles.actionRow}>
                <Button onClick={handleSaveAccount} loading={savingAccount}>
                  {t('common.save')}
                </Button>
              </div>
            </div>
          )}
        </Card>

        {account?.configured && (
          <>
            <Card title={t('account.passkey_settings_title')}>
              <p className={styles.sectionDescription}>{t('account.passkey_settings_desc')}</p>
              <div className={styles.formRow}>
                <Input
                  label={t('account.passkey_rp_id_label')}
                  placeholder={typeof window !== 'undefined' ? window.location.hostname : ''}
                  value={rpId}
                  onChange={(e) => setRpId(e.target.value)}
                  hint={t('account.passkey_rp_id_hint')}
                />
                <div className="form-group">
                  <label>{t('account.passkey_origins_label')}</label>
                  <textarea
                    className={styles.originsInput}
                    value={originsText}
                    onChange={(e) => setOriginsText(e.target.value)}
                    placeholder={typeof window !== 'undefined' ? window.location.origin : ''}
                  />
                  <div className="hint">{t('account.passkey_origins_hint')}</div>
                </div>
                <div className={styles.actionRow}>
                  <Button onClick={handleSavePasskeySettings} loading={savingPasskeySettings}>
                    {t('common.save')}
                  </Button>
                </div>
              </div>
            </Card>

            <Card
              title={t('account.passkeys_title')}
              extra={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleAddPasskey}
                  loading={addingPasskey}
                  disabled={!canAddPasskey}
                  title={canAddPasskey ? undefined : t('account.passkeys_unavailable_hint')}
                >
                  {t('account.add_passkey_button')}
                </Button>
              }
            >
              <p className={styles.sectionDescription}>{t('account.passkeys_desc')}</p>
              {account.passkeys.length === 0 ? (
                <div className="hint">{t('account.no_passkeys')}</div>
              ) : (
                <div className="item-list">
                  {account.passkeys.map((passkey) => (
                    <div key={passkey.id} className="item-row">
                      <div className="item-meta">
                        <span className="item-title">{passkey.name}</span>
                        <span className="item-subtitle">
                          {t('account.created_label')}:{' '}
                          {formatDateTimeValue(passkey.created_at, i18n.language) ||
                            passkey.created_at}
                        </span>
                      </div>
                      <div className="item-actions">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleRenamePasskey(passkey)}
                          loading={renamingId === passkey.id}
                        >
                          {t('common.edit')}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDeletePasskey(passkey)}
                          loading={deletingId === passkey.id}
                          aria-label={t('common.delete')}
                        >
                          <IconTrash2 size={16} />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title={t('account.sign_out_all_title')}>
              <p className={styles.sectionDescription}>{t('account.sign_out_all_desc')}</p>
              <div className={styles.actionRow}>
                <Button variant="danger" onClick={handleSignOutAll} loading={signingOutAll}>
                  {t('account.sign_out_all_button')}
                </Button>
              </div>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}
