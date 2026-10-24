import { useState } from 'react';
import { companyRequest, currentMembership, signOutThisDevice, supabase } from '../webAuth';
import { flushCloud } from '../cloudStorage';

interface Member { userId?: string; user_id?: string; email?: string; role: string }
interface Invitation { id: string; email: string; role: string }
export function CompanyAccount({ flush }: { flush: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('member');
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invitation[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const account = currentMembership();
  const admin = account?.role === 'owner' || account?.role === 'admin';
  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMessage('');
    try { await fn(); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const refresh = async () => {
    const result = await companyRequest('GET') as { members?: Member[]; invites?: Invitation[] } | Member[];
    setMembers(Array.isArray(result) ? result : result.members ?? []);
    setInvites(Array.isArray(result) ? [] : result.invites ?? []);
  };
  return <>
    <button onClick={() => { setOpen(!open); if (!open && admin) void run(refresh); }}>Account</button>
    {open && <div className="modal-backdrop" onClick={() => setOpen(false)}><div className="modal" role="dialog" aria-label="Company account" onClick={(e) => e.stopPropagation()}>
      <div className="panel-head"><h3>Company account</h3><button onClick={() => setOpen(false)}>Close</button></div>
      <p>{account?.email} · {account?.role}</p>
      {message && <p role="status">{message}</p>}
      {admin && <>
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await companyRequest('POST', { email, role }); setEmail(''); await refresh(); setMessage('Invitation sent.'); }); }}>
          <label className="stack">Invite email<input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <label>Role <select value={role} onChange={(e) => setRole(e.target.value)}><option value="member">Member</option>{account?.role === 'owner' && <option value="admin">Admin</option>}</select></label>
          <button disabled={busy}>Send invitation</button>
        </form>
        <h4>Members</h4>
        {members.map((member) => <p key={member.userId ?? member.user_id}>{member.email ?? member.userId ?? member.user_id} · {member.role}{member.role !== 'owner' && (member.role !== 'admin' || account?.role === 'owner') && (member.userId ?? member.user_id) !== account?.userId && <button disabled={busy} onClick={() => { if (window.confirm('Revoke this account’s company access?')) void run(async () => { await companyRequest('DELETE', { userId: member.userId ?? member.user_id }); await refresh(); }); }}>Revoke access</button>}</p>)}
        {invites.length > 0 && <h4>Pending invitations</h4>}
        {invites.map((invite) => <p key={invite.id}>{invite.email} · {invite.role}{(invite.role !== 'admin' || account?.role === 'owner') && <button disabled={busy} onClick={() => void run(async () => { await companyRequest('DELETE', { inviteId: invite.id }); await refresh(); })}>Revoke invitation</button>}</p>)}
      </>}
      <button disabled={busy} onClick={() => void run(async () => { await flush(); await flushCloud(); const { error } = await supabase().auth.signOut(); if (error) throw error; })}>Save and sign out</button>
      <button disabled={busy} onClick={() => {
        if (window.confirm('Discard all unsaved work and sign out on this device? Export your work first if you need it. This cannot be undone.')) void run(signOutThisDevice);
      }}>Discard unsaved work and sign out</button>
    </div></div>}
  </>;
}
