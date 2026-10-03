import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { Collapsible } from '@/components/ui/Collapsible';
import { IconEye, IconEyeOff } from '@/components/ui/icons';
import { useAuthStore, useLanguageStore, useNotificationStore } from '@/stores';
import { sessionApi } from '@/services/api/session';
import { assertionOptionsFromJSON, credentialToJSON, supportsPasskeys } from '@/services/passkey';
import { detectApiBaseFromLocation, normalizeApiBase } from '@/utils/connection';
import { LANGUAGE_LABEL_KEYS, LANGUAGE_ORDER } from '@/utils/constants';
import { isSupportedLanguage } from '@/utils/language';
import { INLINE_LOGO_JPEG } from '@/assets/logoInline';
import type { ApiError } from '@/types';
import { LegacyBackendError } from '@/services/api/legacyBackendProbe';
import styles from './LoginPage.module.scss';

/**
 * 将 API 错误转换为本地化的用户友好消息
 */
type RedirectState = { from?: { pathname?: string } };

function readRetryAfterSeconds(error: unknown): number | null {
  const apiError = error as Partial<ApiError>;
  const details = apiError.details;
  if (details && typeof details === 'object' && 'retry_after' in details) {
    const raw = (details as { retry_after?: unknown }).retry_after;
    const seconds = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds);
  }
  return null;
}

function getLocalizedErrorMessage(error: unknown, t: (key: string) => string): string {
  if (error instanceof LegacyBackendError) return t('login.error_legacy_backend');
  const apiError = error as Partial<ApiError>;
  const status = typeof apiError.status === 'number' ? apiError.status : undefined;
  const code = typeof apiError.code === 'string' ? apiError.code : undefined;
  const message =
    error instanceof Error
      ? error.message
      : typeof apiError.message === 'string'
        ? apiError.message
        : typeof error === 'string'
          ? error
          : '';

  const withHttpStatus = (summary: string) => {
    if (!status) {
      return summary;
    }

    const genericAxiosMessage = `Request failed with status code ${status}`;
    const detail = message.trim();
    const backendDetail =
      detail && detail !== genericAxiosMessage
        ? ` (${t('login.error_backend_detail')}: ${detail})`
        : '';

    return `HTTP ${status}: ${summary}${backendDetail}`;
  };

  // 根据 HTTP 状态码判断
  if (status === 401) {
    return withHttpStatus(t('login.error_unauthorized'));
  }
  if (status === 403) {
    return withHttpStatus(t('login.error_forbidden'));
  }
  if (status === 404) {
    return withHttpStatus(t('login.error_not_found'));
  }
  if (status === 409) {
    return withHttpStatus(t('login.error_no_account'));
  }
  if (status && status >= 500) {
    return withHttpStatus(t('login.error_server'));
  }

  // 根据 axios 错误码判断
  if (code === 'ECONNABORTED' || message.toLowerCase().includes('timeout')) {
    return t('login.error_timeout');
  }
  if (code === 'ERR_NETWORK' || message.toLowerCase().includes('network error')) {
    return t('login.error_network');
  }
  if (code === 'ERR_CERT_AUTHORITY_INVALID' || message.toLowerCase().includes('certificate')) {
    return t('login.error_ssl');
  }

  // 检查 CORS 错误
  if (message.toLowerCase().includes('cors') || message.toLowerCase().includes('cross-origin')) {
    return t('login.error_cors');
  }

  // 默认错误消息
  return withHttpStatus(t('login.error_invalid'));
}

export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { showNotification } = useNotificationStore();
  const language = useLanguageStore((state) => state.language);
  const setLanguage = useLanguageStore((state) => state.setLanguage);
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const login = useAuthStore((state) => state.login);
  const loginWithPassword = useAuthStore((state) => state.loginWithPassword);
  const applySessionLogin = useAuthStore((state) => state.applySessionLogin);
  const restoreSession = useAuthStore((state) => state.restoreSession);
  const refreshSessionStatus = useAuthStore((state) => state.refreshSessionStatus);
  const sessionStatus = useAuthStore((state) => state.sessionStatus);
  const storedBase = useAuthStore((state) => state.apiBase);
  const storedKey = useAuthStore((state) => state.managementKey);
  const storedRememberPassword = useAuthStore((state) => state.rememberPassword);

  const [apiBase, setApiBase] = useState('');
  const [managementKey, setManagementKey] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [rememberPassword, setRememberPassword] = useState(false);
  const [useKeyForm, setUseKeyForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [passkeyLoading, setPasskeyLoading] = useState(false);
  const [autoLoading, setAutoLoading] = useState(true);
  const [autoLoginSuccess, setAutoLoginSuccess] = useState(false);
  const [error, setError] = useState('');
  const [retryAfter, setRetryAfter] = useState(0);
  const retryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const detectedBase = useMemo(() => detectApiBaseFromLocation(), []);
  const languageOptions = useMemo(
    () =>
      LANGUAGE_ORDER.map((lang) => ({
        value: lang,
        label: t(LANGUAGE_LABEL_KEYS[lang]),
      })),
    [t]
  );
  const handleLanguageChange = useCallback(
    (selectedLanguage: string) => {
      if (!isSupportedLanguage(selectedLanguage)) {
        return;
      }
      setLanguage(selectedLanguage);
    },
    [setLanguage]
  );

  useEffect(() => {
    const init = async () => {
      try {
        const autoLoggedIn = await restoreSession();
        if (autoLoggedIn) {
          setAutoLoginSuccess(true);
          // 延迟跳转，让用户看到成功动画
          setTimeout(() => {
            const redirect = (location.state as RedirectState | null)?.from?.pathname || '/';
            navigate(redirect, { replace: true });
          }, 1500);
        } else {
          setApiBase(storedBase || detectedBase);
          setManagementKey(storedKey || '');
          setRememberPassword(storedRememberPassword || Boolean(storedKey));
        }
      } finally {
        // 自动登录成功时 showSplash 仍由 autoLoginSuccess 维持，可无条件结束 loading
        setAutoLoading(false);
      }
    };

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (retryTimerRef.current) clearInterval(retryTimerRef.current);
    };
  }, []);

  const startRetryCountdown = useCallback((seconds: number) => {
    if (retryTimerRef.current) clearInterval(retryTimerRef.current);
    setRetryAfter(seconds);
    retryTimerRef.current = setInterval(() => {
      setRetryAfter((current) => {
        if (current <= 1) {
          if (retryTimerRef.current) clearInterval(retryTimerRef.current);
          return 0;
        }
        return current - 1;
      });
    }, 1000);
  }, []);

  const baseToUse = apiBase ? normalizeApiBase(apiBase) : detectedBase;

  // 当“Advanced”地址变更为其他后端时，重新探测该地址是否已配置账户登录
  const handleApiBaseBlur = useCallback(() => {
    void refreshSessionStatus(baseToUse);
  }, [baseToUse, refreshSessionStatus]);

  const showAccountForm = Boolean(sessionStatus?.account) && !useKeyForm;
  const showPasskeyButton =
    showAccountForm &&
    Boolean(sessionStatus?.passkeys_available) &&
    supportsPasskeys() &&
    typeof window !== 'undefined' &&
    (sessionStatus?.passkey_origins ?? []).includes(window.location.origin);

  const handlePasswordSubmit = useCallback(async () => {
    if (!username.trim() || !password) {
      setError(t('login.error_required'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      await loginWithPassword({ apiBase: baseToUse, username: username.trim(), password });
      showNotification(t('common.connected_status'), 'success');
      navigate('/', { replace: true });
    } catch (err: unknown) {
      const seconds = readRetryAfterSeconds(err);
      if (seconds) startRetryCountdown(seconds);
      const message = getLocalizedErrorMessage(err, t);
      setError(message);
      showNotification(`${t('notification.login_failed')}: ${message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [
    baseToUse,
    loginWithPassword,
    navigate,
    password,
    showNotification,
    startRetryCountdown,
    t,
    username,
  ]);

  const handlePasskeyLogin = useCallback(async () => {
    setPasskeyLoading(true);
    setError('');
    try {
      const begin = await sessionApi.passkeyBegin(baseToUse);
      const options = assertionOptionsFromJSON(
        begin.options as { publicKey: Record<string, unknown> }
      );
      const credential = await navigator.credentials.get(options);
      if (!credential) throw new Error('No credential returned');
      const credentialJSON = credentialToJSON(credential as PublicKeyCredential);
      const response = await sessionApi.passkeyFinish(baseToUse, {
        ceremony_id: begin.ceremony_id,
        credential: credentialJSON,
      });
      applySessionLogin(baseToUse, response, 'passkey');
      showNotification(t('common.connected_status'), 'success');
      navigate('/', { replace: true });
    } catch (err: unknown) {
      if (
        err instanceof DOMException &&
        (err.name === 'NotAllowedError' || err.name === 'AbortError')
      ) {
        setError(t('login.error_passkey_cancelled'));
      } else {
        const message = getLocalizedErrorMessage(err, t);
        setError(message);
        showNotification(`${t('notification.login_failed')}: ${message}`, 'error');
      }
    } finally {
      setPasskeyLoading(false);
    }
  }, [applySessionLogin, baseToUse, navigate, showNotification, t]);

  const handleKeySubmit = useCallback(async () => {
    if (!managementKey.trim()) {
      setError(t('login.error_required'));
      return;
    }

    setLoading(true);
    setError('');
    try {
      await login({
        apiBase: baseToUse,
        managementKey: managementKey.trim(),
        rememberPassword,
      });
      showNotification(t('common.connected_status'), 'success');
      navigate('/', { replace: true });
    } catch (err: unknown) {
      const message = getLocalizedErrorMessage(err, t);
      setError(message);
      showNotification(`${t('notification.login_failed')}: ${message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [baseToUse, login, managementKey, navigate, rememberPassword, showNotification, t]);

  const handleSubmit = showAccountForm ? handlePasswordSubmit : handleKeySubmit;

  const handleSubmitKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'Enter' && !loading && retryAfter === 0) {
        event.preventDefault();
        handleSubmit();
      }
    },
    [loading, retryAfter, handleSubmit]
  );

  if (isAuthenticated && !autoLoading && !autoLoginSuccess) {
    const redirect = (location.state as RedirectState | null)?.from?.pathname || '/';
    return <Navigate to={redirect} replace />;
  }

  // 显示启动动画（自动登录中或自动登录成功）
  const showSplash = autoLoading || autoLoginSuccess;

  return (
    <div className={styles.container}>
      {/* 左侧品牌展示区 */}
      <div className={styles.brandPanel}>
        <div className={styles.brandContent}>
          <span className={styles.brandWord}>CLI</span>
          <span className={styles.brandWord}>PROXY</span>
          <span className={styles.brandWord}>API</span>
        </div>
      </div>

      {/* 右侧功能交互区 */}
      <div className={styles.formPanel}>
        {showSplash ? (
          /* 启动动画 */
          <div className={styles.splashContent}>
            <img src={INLINE_LOGO_JPEG} alt="CPAMC" className={styles.splashLogo} />
            <h1 className={styles.splashTitle}>{t('splash.title')}</h1>
            <p className={styles.splashSubtitle}>{t('splash.subtitle')}</p>
            <div className={styles.splashLoader}>
              <div className={styles.splashLoaderBar} />
            </div>
          </div>
        ) : (
          /* 登录表单 */
          <div className={styles.formContent}>
            {/* Logo */}
            <img src={INLINE_LOGO_JPEG} alt="Logo" className={styles.logo} />

            {/* 登录表单卡片 */}
            <div className={styles.loginCard}>
              <div className={styles.loginHeader}>
                <div className={styles.titleRow}>
                  <div className={styles.title}>{t('title.login')}</div>
                  <Select
                    className={styles.languageSelect}
                    value={language}
                    options={languageOptions}
                    onChange={handleLanguageChange}
                    fullWidth={false}
                    ariaLabel={t('language.switch')}
                  />
                </div>
                <div className={styles.subtitle}>{t('login.subtitle')}</div>
              </div>

              {showAccountForm ? (
                <>
                  <Input
                    autoFocus
                    label={t('login.username_label')}
                    placeholder={t('login.username_placeholder')}
                    name="cpa-username"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onKeyDown={handleSubmitKeyDown}
                  />

                  <Input
                    label={t('login.password_label')}
                    placeholder={t('login.password_placeholder')}
                    type={showPassword ? 'text' : 'password'}
                    name="cpa-password"
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={handleSubmitKeyDown}
                    rightElement={
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setShowPassword((prev) => !prev)}
                        aria-label={showPassword ? t('login.hide_key') : t('login.show_key')}
                        title={showPassword ? t('login.hide_key') : t('login.show_key')}
                      >
                        {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                      </button>
                    }
                  />

                  {retryAfter > 0 && (
                    <div className={styles.errorBox}>
                      {t('login.retry_after_message', { seconds: retryAfter })}
                    </div>
                  )}

                  <Button
                    fullWidth
                    onClick={handleSubmit}
                    loading={loading}
                    disabled={retryAfter > 0}
                  >
                    {loading ? t('login.submitting') : t('login.submit_button')}
                  </Button>

                  {showPasskeyButton && (
                    <Button
                      fullWidth
                      variant="secondary"
                      onClick={handlePasskeyLogin}
                      loading={passkeyLoading}
                      disabled={loading}
                    >
                      {t('login.passkey_button')}
                    </Button>
                  )}

                  {error && <div className={styles.errorBox}>{error}</div>}

                  <div className={styles.toggleAdvanced}>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setUseKeyForm(true);
                        setError('');
                      }}
                    >
                      {t('login.use_key_instead')}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className={styles.connectionBox}>
                    <div className={styles.label}>{t('login.connection_current')}</div>
                    <div className={styles.value}>{apiBase || detectedBase}</div>
                    <div className={styles.hint}>{t('login.connection_auto_hint')}</div>
                  </div>

                  <Input
                    autoFocus
                    label={t('login.management_key_label')}
                    placeholder={t('login.management_key_placeholder')}
                    type={showKey ? 'text' : 'password'}
                    name="cpa-management-key"
                    autoComplete="current-password"
                    value={managementKey}
                    onChange={(e) => setManagementKey(e.target.value)}
                    onKeyDown={handleSubmitKeyDown}
                    rightElement={
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setShowKey((prev) => !prev)}
                        aria-label={showKey ? t('login.hide_key') : t('login.show_key')}
                        title={showKey ? t('login.hide_key') : t('login.show_key')}
                      >
                        {showKey ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                      </button>
                    }
                  />

                  <div className={styles.toggleAdvanced}>
                    <SelectionCheckbox
                      checked={rememberPassword}
                      onChange={setRememberPassword}
                      ariaLabel={t('login.remember_password_label')}
                      label={t('login.remember_password_label')}
                      labelClassName={styles.toggleLabel}
                    />
                  </div>

                  <Button fullWidth onClick={handleSubmit} loading={loading}>
                    {loading ? t('login.submitting') : t('login.submit_button')}
                  </Button>

                  {error && <div className={styles.errorBox}>{error}</div>}

                  {Boolean(sessionStatus?.account) && useKeyForm && (
                    <div className={styles.toggleAdvanced}>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          setUseKeyForm(false);
                          setError('');
                        }}
                      >
                        {t('login.use_account_instead')}
                      </button>
                    </div>
                  )}
                </>
              )}

              <Collapsible label={t('login.advanced_toggle')}>
                <Input
                  label={t('login.custom_connection_label')}
                  placeholder={t('login.custom_connection_placeholder')}
                  value={apiBase}
                  onChange={(e) => setApiBase(e.target.value)}
                  onBlur={handleApiBaseBlur}
                  hint={t('login.custom_connection_hint')}
                />
              </Collapsible>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
