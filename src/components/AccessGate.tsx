import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { clearMembership, companyErrorMessage, confirmedAccessLoss, currentMembership, lockCompanyAccess, signOutThisDevice, supabase, validateMembership, webMode } from '../webAuth';
import { resetCloud } from '../cloudStorage';

function CompanyGate({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [settingPassword, setSettingPassword] = useState(() => /(?:type=(?:invite|recovery))/.test(location.hash + location.search));
  const validation = useRef(0);
  const [verificationError, setVerificationError] = useState('');
  const validate = async () => {
    const generation = ++validation.current;
    try {
      const { data, error: sessionError } = await supabase().auth.getSession();
      if (generation !== validation.current) return;
      if (sessionError) throw sessionError;
      if (!data.session) { setAccount(null); clearMembership(); resetCloud(); return; }
      const member = await validateMembership();
      if (generation !== validation.current) return;
      setAccount(member.userId);
      lockCompanyAccess(false); setVerificationError('');
      setError('');
    } catch (e) {
      if (generation !== validation.current) return;
      const message = companyErrorMessage(e);
      if (confirmedAccessLoss(e)) {
        setAccount(null); clearMembership(); resetCloud(); setVerificationError('');
      } else {
        lockCompanyAccess(true); setVerificationError(message);
      }
      setError(message);
    } finally { if (generation === validation.current) setChecking(false); }
  };
  useEffect(() => {
    let active = true;
    try {
      const api = supabase();
      const { data } = api.auth.onAuthStateChange((event, session) => {
        if (!active) return;
        validation.current++;
        if (event === 'PASSWORD_RECOVERY') setSettingPassword(true);
        if (!session || (currentMembership() && session.user.id !== currentMembership()!.userId)) {
          setAccount(null); clearMembership(); resetCloud();
        }
        // Do not call Supabase APIs inside the SDK's auth callback lock.
        window.setTimeout(() => { if (active) void validate(); }, 0);
      });
      void validate();
      const timer = window.setInterval(() => void validate(), 60000);
      const focus = () => { if (document.visibilityState === 'visible') void validate(); };
      document.addEventListener('visibilitychange', focus);
      return () => { active = false; validation.current++; data.subscription.unsubscribe(); clearInterval(timer); document.removeEventListener('visibilitychange', focus); };
    } catch (e) { setError((e as Error).message); setChecking(false); }
  }, []);
  const submit = async (reset = false) => {
    setChecking(true); setError(''); setNotice('');
    try {
      const api = supabase();
      if (reset) {
        const { error } = await api.auth.resetPasswordForEmail(email.trim(), { redirectTo: location.origin + location.pathname });
        if (error) throw error;
        setNotice('If this email has an account, a password reset link has been sent.');
      } else if (settingPassword) {
        if (password.length < 12) throw new Error('Use at least 12 characters for your password.');
        const { error } = await api.auth.updateUser({ password });
        if (error) throw error;
        setSettingPassword(false); setPassword('');
        history.replaceState(null, '', location.pathname);
        await validate();
      } else {
        const { error } = await api.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
        setPassword(''); await validate();
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setChecking(false); }
  };
  if (account && !settingPassword) return <Fragment key={account}>
    <div style={{ display: 'contents' }} inert={!!verificationError}>{children}</div>
    {verificationError && <div className="modal-backdrop auth-verification"><div className="modal" role="alertdialog" aria-label="Connection verification required"><h3>Company access could not be verified</h3><p>{verificationError}</p><p>Your unsaved work is kept in this tab. Editing is paused until access is verified. Do not reload.</p><button onClick={() => void validate()}>Retry verification</button><button onClick={() => { if (window.confirm('Discard unsaved work and sign out on this device? This cannot be undone.')) void signOutThisDevice().catch((e) => setVerificationError(companyErrorMessage(e))); }}>Discard unsaved work and sign out</button></div></div>}
  </Fragment>;
  return <div className="access-gate"><form className="access-card" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
    <h1>Takeoff AI</h1>
    <p className="muted">{settingPassword ? 'Set your account password to continue.' : 'Sign in with your invited company account. Public registration is not available.'}</p>
    {!settingPassword && <label className="stack">Email<input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></label>}
    <label className="stack">Password<input type="password" required minLength={settingPassword ? 12 : undefined} autoComplete={settingPassword ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
    {error && <p role="alert" className="field-hint error">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <button className="on" disabled={checking}>{checking ? 'Checking…' : settingPassword ? 'Set password' : 'Sign in'}</button>
    {!settingPassword && <button type="button" disabled={checking || !email.trim()} onClick={() => void submit(true)}>Reset password</button>}
    {!settingPassword && <button type="button" disabled={checking} onClick={() => {
      void (async () => {
        try {
          const { error } = await supabase().auth.signOut();
          if (error) throw error;
          clearMembership(); resetCloud(); setAccount(null); setPassword(''); setError(''); setNotice('Signed out.');
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      })();
    }}>Clear sign-in / sign out</button>}
    {settingPassword && <button type="button" onClick={() => { void supabase().auth.signOut().then(() => { setSettingPassword(false); setAccount(null); }).catch((e) => setError(String(e))); }}>Cancel / sign out</button>}
  </form></div>;
}
export function AccessGate({ children }: { children: ReactNode }) {
  return webMode ? <CompanyGate>{children}</CompanyGate> : <>{children}</>;
}
