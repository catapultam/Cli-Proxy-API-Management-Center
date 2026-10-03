import { useEffect, useState, type ReactElement } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

export function ProtectedRoute({ children }: { children: ReactElement }) {
  const location = useLocation();
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated);
  const managementKey = useAuthStore((state) => state.managementKey);
  const apiBase = useAuthStore((state) => state.apiBase);
  const authMode = useAuthStore((state) => state.authMode);
  const checkAuth = useAuthStore((state) => state.checkAuth);
  const restoreSession = useAuthStore((state) => state.restoreSession);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const tryRestore = async () => {
      if (isAuthenticated || !apiBase) return;
      // Session mode (including cookie mode, which has no stored key) must go through
      // `restoreSession`, which re-validates against `session/status` rather than just the key.
      if (authMode !== 'session' && !managementKey) return;

      setChecking(true);
      try {
        if (authMode === 'session') {
          await restoreSession();
        } else {
          await checkAuth();
        }
      } finally {
        setChecking(false);
      }
    };
    tryRestore();
  }, [apiBase, isAuthenticated, managementKey, authMode, checkAuth, restoreSession]);

  if (checking) {
    return (
      <div className="main-content">
        <LoadingSpinner />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}
