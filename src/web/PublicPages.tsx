import { useEffect, useState } from "react";
import { apiJson, toMessage, type PublicUser } from "./App";
import { LegalFooter, PolicyNotice } from "./LegalPages";
const tokenKey = "cloud-markdown-notes-token";

export function LandingPage() {
  return <main className="landing">
    <header className="site-header"><a className="site-brand" href="/">Notes<span> / your words, kept simple</span></a><nav><a href="#features">Features</a><a href="#pricing">Pricing</a><a href="/login">Log in</a><a className="button-link primary" href="/register">Register</a></nav></header>
    <section className="hero"><p className="eyebrow">A QUIET PLACE FOR YOUR IDEAS</p><h1>Write it down.<br/><em>Make it yours.</em></h1><p className="hero-copy">A cloud workspace for Markdown notes. Keep your writing organised, revisit every version, and share what matters.</p><div className="hero-actions"><a className="button-link primary" href="/register">Start your notebook ↗</a><a href="/app">Open workspace →</a></div><p className="subtle">Web · CLI · MCP — one workspace, wherever you work.</p><div className="note-sample" aria-label="Example Markdown note"><div className="sample-bar"><span>notes / everyday.md</span><span>Markdown</span></div><p className="sample-date">A LITTLE SPACE TO THINK</p><h2>Good ideas start with a note.</h2><p>Capture a thought. Connect the pieces.<br/>Come back when you're ready.</p><ul><li>Keep the things you want to remember</li><li>Find the version you need</li><li>Share a finished thought</li></ul><span className="sample-tag"># a work in progress</span></div></section>
    <section id="features" className="features"><div><p className="eyebrow">LESS FRICTION. MORE WRITING.</p><h2>Small tools.<br/>Room for big ideas.</h2></div><article><span>01 / WRITE</span><h3>Plain text, beautifully useful</h3><p>Markdown editing and preview, folders and fast search. Your notes stay readable and portable.</p></article><article><span>02 / REVISIT</span><h3>A history you can return to</h3><p>Commit your changes, inspect differences and restore previous versions whenever you need them.</p></article><article><span>03 / CONNECT</span><h3>Made for your workflow</h3><p>Use the browser, CLI or MCP. Import and export ZIP archives, and publish committed notes with a link.</p></article></section>
    <section id="pricing" className="pricing"><div><p className="eyebrow">ONE SIMPLE PLAN</p><h2>A home for your notes.<br/>A small monthly price.</h2><p>All the essentials, with no complicated tiers.</p></div><article className="plan-card"><span>NOTES MONTHLY</span><h3>HK$10 <small>/ month</small></h3><p>Billed monthly in HKD. Automatically renews until cancelled. Applicable taxes are shown at checkout.</p><ul><li>Up to 1,000 Markdown notes</li><li>Version history, search and public sharing</li><li>Web, CLI and MCP access</li><li>ZIP import and export</li></ul><a className="button-link primary" href="/register">Create account & subscribe →</a><p className="subtle">Register first, then pay securely with Stripe. Your account activates after payment confirmation.</p></article></section>
    <section className="faq"><h2>A few useful details.</h2><details><summary>When can I start using Notes?</summary><p>After registration, subscribe to activate your workspace. Administrator activation is also available.</p></details><details><summary>Can I cancel?</summary><p>Yes. Open Billing to manage your subscription. You keep access for the paid period. After it ends, the account returns to pending; your notes remain stored.</p></details><details><summary>What if a renewal payment fails?</summary><p>Access lasts until the paid period ends. Update your payment method through Billing to resume. A failed payment does not add a new month.</p></details></section>
    <LegalFooter />
  </main>;
}

type BillingStatus = { user: PublicUser; status: string | null; currentPeriodEnd: string | null; active: boolean; manualAccess: boolean; hasCustomer: boolean; enabled: boolean; cancelAt: string | null; cancelAtPeriodEnd: boolean; canceledAt: string | null };
export function BillingPage() {
  const token = window.localStorage.getItem(tokenKey);
  const [data, setData] = useState<BillingStatus | null>(null);
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState(new URLSearchParams(location.search).get("checkout") === "cancelled" ? "Checkout cancelled. You can try again when ready." : "");
  const [busy, setBusy] = useState(false);
  const success = new URLSearchParams(location.search).get("checkout") === "success";
  useEffect(() => {
    if (!token) { window.location.replace("/login"); return; }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    async function load() {
      try {
        const next = await apiJson<BillingStatus>("/api/billing/status", { token });
        if (stopped) return;
        setData(next); setEmail(next.user.email ?? "");
        if (success && !next.active) {
          setMessage(attempts < 20 ? "Confirming payment… You can safely return to this page later." : "Payment confirmation is taking longer than expected. Refresh later; do not pay again.");
          if (++attempts < 20) timer = setTimeout(() => void load(), 1500);
        } else if (success) setMessage("Payment confirmed. Your workspace is ready.");
      } catch (error) { if (!stopped) setMessage(toMessage(error)); }
    }
    void load();
    return () => { stopped = true; clearTimeout(timer); };
  }, [token, success]);
  async function action(path: string) {
    setBusy(true); setMessage("");
    try {
      const result = await apiJson<{url?: string; token?: string}>(path, { method: "POST", token });
      if (result.token) { window.localStorage.setItem(tokenKey, result.token); window.location.href = "/app"; }
      else if (result.url) window.location.href = result.url;
    } catch (error) { setMessage(toMessage(error)); } finally { setBusy(false); }
  }
  async function saveEmail() {
    setBusy(true);
    try { await apiJson("/api/billing/email", { method: "PUT", token, body: { email } }); setData(await apiJson<BillingStatus>("/api/billing/status", { token })); setMessage("Email saved."); }
    catch (error) { setMessage(toMessage(error)); } finally { setBusy(false); }
  }
  const cancellationScheduled = Boolean(data?.cancelAtPeriodEnd || data?.cancelAt);
  return <div className="public-account-site"><main className="billing-layout"><a href="/">← Notes home</a><section className="billing-card"><p className="eyebrow">YOUR ACCOUNT</p><h1>Subscription & access</h1>{data ? <><p>{data.user.username} · <strong>{data.active ? "Active" : "Pending activation"}</strong></p><p>{data.manualAccess ? "Administrator activation is enabled for your account." : data.status === "canceled" ? "Subscription cancelled · no further renewal" : cancellationScheduled ? "Cancellation scheduled · no further renewal" : "HKD 10 / month · automatically renews until cancelled"}</p>{data.currentPeriodEnd && <p>Paid access until {new Date(data.currentPeriodEnd).toLocaleString()}</p>}{data.cancelAt && data.status !== "canceled" && <p>Cancellation effective on {new Date(data.cancelAt).toLocaleString()}</p>}{cancellationScheduled && data.active && !data.manualAccess && <p className="notice">Your workspace remains available until the paid period ends. It will then return to pending unless you subscribe again.</p>}{data.status && <p>Subscription: {data.status}</p>}<label>Email<input type="email" value={email} onChange={e => setEmail(e.target.value)} /></label><button disabled={busy || !email} onClick={() => void saveEmail()}>Save email</button>{!data.enabled && <p>Online payments are not available yet. Administrator activation remains available.</p>}<PolicyNotice /><div className="billing-actions">{data.active && <button className="primary" disabled={busy} onClick={() => void action("/api/billing/workspace-session")}>Open workspace</button>}{(!data.status || ["canceled", "incomplete_expired"].includes(data.status)) && <button className="primary" disabled={busy || !data.enabled || !data.user.email} onClick={() => void action("/api/billing/checkout-session")}>Subscribe · HKD 10/month</button>}{data.hasCustomer && <button disabled={busy || !data.enabled} onClick={() => void action("/api/billing/portal-session")}>Manage subscription</button>}<button onClick={() => window.location.reload()}>Refresh status</button></div><p className="subtle">Payment confirmation activates your workspace. Cancelling stops future renewals; existing paid access lasts until the date shown. Expiry preserves your notes.</p></> : <p>Loading account…</p>}{message && <p role="status" className="message">{message}</p>}<button className="ghost" onClick={() => { void apiJson("/api/auth/logout", { method: "POST", token }).finally(() => { window.localStorage.removeItem(tokenKey); window.location.href = "/login"; }); }}>Logout</button></section></main><LegalFooter /></div>;
}
