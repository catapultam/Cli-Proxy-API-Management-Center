import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { IconEye, IconEyeOff, IconTrash2 } from '@/components/ui/icons';
import { useAuthStore, useNotificationStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import { accountApi } from '@/services/api/account';
import {
  creationOptionsFromJSON,
  credentialToJSON,
  guessDeviceName,
  supportsPasskeys,
} from '@/services/passkey';
import { getErrorMessage } from '@/utils/helpers';
import { formatDateTimeValue } from '@/utils/format';
import type { AccountPasskey, AccountView, ApiError } from '@/types';
import styles from './AccountPage.module.scss';

const MIN_PASSWORD_LENGTH = 12;

const isRateLimited = (err: unknown): boolean => (err as Partial<ApiError>)?.status === 429;

export function AccountPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { showNotification, showConfirmation } = useNotificationStore();
  const authMode = useAuthStore((state) => state.authMode);
  const apiBase = useAuthStore((state) => state.apiBase);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const applySessionLogin = useAuthStore((state) => state.applySessionLogin);
  const adoptRotatedToken = useAuthStore((state) => state.adoptRotatedToken);
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
  const [passkeySettingsPassword, setPasskeySettingsPassword] = useState('');
  const [savingPasskeySettings, setSavingPasskeySettings] = useState(false);

  const [addPasskeyPassword, setAddPasskeyPassword] = useState('');
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
    () =>
      account?.configured
        ? t('account.password_hint_keep_current', { count: MIN_PASSWORD_LENGTH })
        : t('account.password_hint', { count: MIN_PASSWORD_LENGTH }),
    [account?.configured, t]
  );

  const rpIdChanged = Boolean(
    account?.passkeys.length && rpId.trim() && rpId.trim() !== account.passkey_rp_id
  );

  const handleSaveAccount = useCallback(async () => {
    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      showNotification(t('account.error_username_required'), 'error');
      return;
    }
    const wasSessionBefore = authMode === 'session';
    const isFirstTimeSetup = !account?.configured;
    // On an existing account an empty password keeps the current one (username-only changes are
    // valid); the password is only required on first-time setup.
    if (isFirstTimeSetup && !password) {
      showNotification(t('account.error_password_required'), 'error');
      return;
    }
    if (password && password.length < MIN_PASSWORD_LENGTH) {
      showNotification(passwordHint, 'error');
      return;
    }
    // Over a session, ANY change to an existing account (even username-only) requires the
    // current password; over the management key it is never required.
    if (requiresCurrentPassword && !currentPassword) {
      showNotification(t('account.error_current_password_required'), 'error');
      return;
    }

    setSavingAccount(true);
    // This mutation can legitimately invalidate the caller's own current session as a side effect
    // (a password change rotates session-secret); a 401 racing with that must not also trigger a
    // surprise global logout — this handler deals with the outcome explicitly below.
    const releaseUnauthorizedSuspend = apiClient.suspendUnauthorizedHandling();
    try {
      const response = await accountApi.save({
        username: trimmedUsername,
        password,
        ...(requiresCurrentPassword ? { current_password: currentPassword } : {}),
      });
      if (wasSessionBefore) {
        // Same identity, just a rotated token (e.g. from a password change): never treat this as
        // a fresh login, which would otherwise needlessly clear every cache and bump identityVersion.
        adoptRotatedToken(apiBase, response);
      } else {
        // A genuine transition into session mode (first-time setup, or a key-mode admin resetting
        // an existing account's password) — this IS a real new session. There is no "Remember
        // me" checkbox on this page; applySessionLogin derives the effective remember itself from
        // `response.remember ?? true` (the right default: true for a key-authenticated caller, or
        // the prior session's own choice when this was itself issued over a session -- see
        // resolvedSessionRemember server-side -- or true if an older backend omits the field).
        await applySessionLogin(apiBase, response, 'password');
      }
      setAccount((prev) =>
        prev ? { ...prev, configured: true, username: trimmedUsername } : prev
      );
      setPassword('');
      setCurrentPassword('');
      showNotification(t('account.account_saved'), 'success');
    } catch (err: unknown) {
      if (isRateLimited(err)) {
        showNotification(t('account.error_rate_limited'), 'error');
      } else {
        const message = getErrorMessage(err);
        showNotification(
          `${t('account.account_save_failed')}${message ? `: ${message}` : ''}`,
          'error'
        );
      }
    } finally {
      releaseUnauthorizedSuspend();
      setSavingAccount(false);
    }
  }, [
    account?.configured,
    adoptRotatedToken,
    apiBase,
    applySessionLogin,
    authMode,
    currentPassword,
    password,
    passwordHint,
    requiresCurrentPassword,
    showNotification,
    t,
    username,
  ]);

  const handleSavePasskeySettings = useCallback(async () => {
    if (requiresCurrentPassword && !passkeySettingsPassword) {
      showNotification(t('account.error_current_password_required'), 'error');
      return;
    }

    const origins = originsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);

    setSavingPasskeySettings(true);
    const releaseUnauthorizedSuspend = apiClient.suspendUnauthorizedHandling();
    try {
      const data = await accountApi.savePasskeySettings({
        rp_id: rpId.trim(),
        origins,
        ...(requiresCurrentPassword ? { current_password: passkeySettingsPassword } : {}),
      });
      setAccount(data);
      setPasskeySettingsPassword('');
      showNotification(t('account.passkey_settings_saved'), 'success');
    } catch (err: unknown) {
      if (isRateLimited(err)) {
        showNotification(t('account.error_rate_limited'), 'error');
      } else {
        const message = getErrorMessage(err);
        showNotification(
          `${t('account.passkey_settings_save_failed')}${message ? `: ${message}` : ''}`,
          'error'
        );
      }
    } finally {
      releaseUnauthorizedSuspend();
      setSavingPasskeySettings(false);
    }
  }, [originsText, passkeySettingsPassword, requiresCurrentPassword, rpId, showNotification, t]);

  const handleAddPasskey = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (requiresCurrentPassword && !addPasskeyPassword) {
      showNotification(t('account.error_current_password_required'), 'error');
      return;
    }
    const suggested = guessDeviceName(navigator.userAgent);
    const name = window.prompt(t('account.passkey_name_prompt'), suggested);
    if (!name) return;

    setAddingPasskey(true);
    try {
      // The passkey settings form is pre-filled from this page's address; if they were never
      // saved, save them now so adding a passkey is a single step.
      if (!account?.passkey_rp_id) {
        const origins = originsText
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        const releaseUnauthorizedSuspend = apiClient.suspendUnauthorizedHandling();
        try {
          const saved = await accountApi.savePasskeySettings({
            rp_id: rpId.trim(),
            origins,
            ...(requiresCurrentPassword ? { current_password: addPasskeyPassword } : {}),
          });
          setAccount(saved);
        } finally {
          releaseUnauthorizedSuspend();
        }
      }
      const begin = await accountApi.passkeysBegin(
        requiresCurrentPassword ? { current_password: addPasskeyPassword } : undefined
      );
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
      setAddPasskeyPassword('');
      showNotification(t('account.passkey_added'), 'success');
    } catch (err: unknown) {
      if (
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'AbortError')
      ) {
        return;
      }
      const status = (err as Partial<ApiError>)?.status;
      if (status === 410) {
        // The ceremony challenge expired or was already used (registration failures are 410/400,
        // never 401 — a wrong ceremony is not an authentication failure).
        showNotification(t('account.passkey_ceremony_expired'), 'error');
      } else if (isRateLimited(err)) {
        showNotification(t('account.error_rate_limited'), 'error');
      } else {
        const message = getErrorMessage(err);
        showNotification(
          `${t('account.passkey_add_failed')}${message ? `: ${message}` : ''}`,
          'error'
        );
      }
    } finally {
      setAddingPasskey(false);
    }
  }, [
    account?.passkey_rp_id,
    addPasskeyPassword,
    originsText,
    requiresCurrentPassword,
    rpId,
    showNotification,
    t,
  ]);

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
        // Sign-out-all rotates session-secret and clears the caller's own cookie as a side
        // effect: an incidental 401 during this window must not also trigger a surprise global
        // logout before we get to handle it (navigate away) ourselves, below.
        const releaseUnauthorizedSuspend = apiClient.suspendUnauthorizedHandling();
        try {
          await accountApi.signOutAll();
          showNotification(t('account.signed_out_all'), 'success');
          // A key-mode admin's auth doesn't go through sessions at all, so they stay logged in;
          // only a session-mode caller needs to be logged out locally too.
          if (authMode === 'session') {
            await logout();
            navigate('/login', { replace: true });
          }
        } catch (err: unknown) {
          const message = getErrorMessage(err);
          showNotification(
            `${t('account.sign_out_all_failed')}${message ? `: ${message}` : ''}`,
            'error'
          );
        } finally {
          releaseUnauthorizedSuspend();
          setSigningOutAll(false);
        }
      },
    });
  }, [authMode, logout, navigate, showConfirmation, showNotification, t]);

  // Unsaved settings are fine: handleAddPasskey saves the pre-filled rp id first.
  const browserSupportsPasskeys = supportsPasskeys();
  const canAddPasskey =
    Boolean(account?.configured) &&
    Boolean(account?.passkey_rp_id || rpId.trim()) &&
    browserSupportsPasskeys;
  const addPasskeyBlockedHint = !browserSupportsPasskeys
    ? t('account.passkeys_need_https_hint')
    : t('account.passkeys_unavailable_hint');

  if (!loadingAccount && loadError) {
    return (
      <div className={styles.container}>
        <h1 className={styles.pageTitle}>{t('account.title')}</h1>
        <div className={styles.content}>
          <Card>
            <div className="error-box">{loadError}</div>
            <div className={styles.actionRow}>
              <Button onClick={loadAccount}>{t('account.retry_button')}</Button>
            </div>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <h1 className={styles.pageTitle}>{t('account.title')}</h1>
      <div className={styles.content}>
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
                {rpIdChanged && (
                  <div className="status-badge warning">{t('account.rp_id_change_warning')}</div>
                )}
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
                {requiresCurrentPassword && (
                  <Input
                    label={t('account.current_password_label')}
                    type="password"
                    value={passkeySettingsPassword}
                    onChange={(e) => setPasskeySettingsPassword(e.target.value)}
                    autoComplete="current-password"
                    hint={t('account.current_password_required_hint')}
                  />
                )}
                <div className={styles.actionRow}>
                  <Button onClick={handleSavePasskeySettings} loading={savingPasskeySettings}>
                    {t('common.save')}
                  </Button>
                </div>
              </div>
            </Card>

            <Card title={t('account.passkeys_title')}>
              <p className={styles.sectionDescription}>{t('account.passkeys_desc')}</p>
              {requiresCurrentPassword && (
                <Input
                  label={t('account.current_password_label')}
                  type="password"
                  value={addPasskeyPassword}
                  onChange={(e) => setAddPasskeyPassword(e.target.value)}
                  autoComplete="current-password"
                  hint={t('account.current_password_required_hint')}
                />
              )}
              <div className={styles.passkeyStack}>
                <div className={styles.actionRow}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={handleAddPasskey}
                    loading={addingPasskey}
                    disabled={!canAddPasskey}
                    title={canAddPasskey ? undefined : addPasskeyBlockedHint}
                  >
                    {t('account.add_passkey_button')}
                  </Button>
                </div>
                {!canAddPasskey && <div className="hint">{addPasskeyBlockedHint}</div>}
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
              </div>
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
