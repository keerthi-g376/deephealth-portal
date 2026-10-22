import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api } from './api.js';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

// Who is signed in (from the server's signed session cookie) and the sign-in dialog's open state.
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [dialog, setDialog] = useState(false);

  useEffect(() => {
    api
      .me()
      .then((d) => setUser(d.user))
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    const open = () => setDialog(true);
    window.addEventListener('dh-auth-required', open);
    return () => window.removeEventListener('dh-auth-required', open);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout().catch(() => {});
    setUser(null);
    window.location.hash = '#/';
  }, []);

  const value = useMemo(
    () => ({ user, ready, dialog, openSignIn: () => setDialog(true), closeSignIn: () => setDialog(false), setUser, signOut }),
    [user, ready, dialog, signOut],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
