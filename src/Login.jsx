import { useState } from 'react';
import { supabase } from './supabase.js';

export default function Login() {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [msg, setMsg] = useState('');

  async function sendLink(e) {
    e.preventDefault();
    const addr = email.trim().toLowerCase();
    if (!addr) return;
    setStatus('sending');
    const { error } = await supabase.auth.signInWithOtp({
      email: addr,
      options: { emailRedirectTo: window.location.href.split('#')[0] },
    });
    if (error) { setStatus('error'); setMsg(error.message); }
    else { setStatus('sent'); }
  }

  return (
    <div className="center-screen">
      <div className="gate-card">
        <div className="gate-logo">📊</div>
        <h1>Daily Sales Leaders</h1>
        {status === 'sent' ? (
          <>
            <p>Check your email. We sent a sign-in link to <strong>{email.trim().toLowerCase()}</strong>.</p>
            <p className="muted">Open it on this device to enter the board.</p>
            <button className="btn-ghost" onClick={() => setStatus('idle')}>Use a different email</button>
          </>
        ) : (
          <form onSubmit={sendLink}>
            <p className="muted">Group-wide store sales. Sign in with your work email to continue.</p>
            <input
              type="email" required autoFocus placeholder="you@dealership.com"
              value={email} onChange={(e) => setEmail(e.target.value)}
              className="input"
            />
            <button className="btn" type="submit" disabled={status === 'sending'}>
              {status === 'sending' ? 'Sending…' : 'Email me a sign-in link'}
            </button>
            {status === 'error' && <p className="err">{msg}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
