import { useEffect, useState } from 'react';
import { supabase } from './supabase.js';
import Login from './Login.jsx';
import BoardView from './BoardView.jsx';
import { SAMPLE_DAILY } from './_sampleData.js'; // DEV-only; tree-shaken in prod

export default function App() {
  // DEV-ONLY: /?preview=1 renders the board with sample data (no login). This whole
  // branch is behind import.meta.env.DEV so Vite drops it from the production build.
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('preview')) {
    return <BoardView email="preview@dev" sampleDaily={SAMPLE_DAILY} />;
  }

  const [session, setSession] = useState(undefined); // undefined = loading
  const [authorized, setAuthorized] = useState(null); // null = unknown

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      setAuthorized(null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    supabase.rpc('is_sales_authorized').then(({ data }) => {
      if (!cancelled) setAuthorized(Boolean(data));
    });
    return () => { cancelled = true; };
  }, [session]);

  if (session === undefined) {
    return <div className="center-screen"><div className="spinner" /></div>;
  }
  if (!session) return <Login />;

  if (authorized === null) {
    return <div className="center-screen"><div className="spinner" /></div>;
  }
  if (!authorized) {
    return (
      <div className="center-screen">
        <div className="gate-card">
          <div className="gate-logo">📊</div>
          <h1>Daily Sales Leaders</h1>
          <p>You're signed in as <strong>{session.user.email}</strong>, but this account isn't
            approved for the sales board yet.</p>
          <p className="muted">Ask Austin to add your email, then sign in again.</p>
          <button className="btn" onClick={() => supabase.auth.signOut()}>Sign out</button>
        </div>
      </div>
    );
  }

  return <BoardView email={session.user.email} />;
}
