import { useEffect, useState } from "react";
import { apiJson, toMessage, type PublicUser } from "./App";
import { LegalFooter, PolicyNotice } from "./LegalPages";
import { HomeGuides } from "./HomeGuides";

const tokenKey = "cloud-markdown-notes-token";

export function LandingPage() {
  const readSession = () => Boolean(localStorage.getItem(tokenKey));
  const [hasSession, setHasSession] = useState(readSession);
  useEffect(() => {
    const sync = () => setHasSession(readSession());
    window.addEventListener("storage", sync);
    window.addEventListener("pageshow", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("pageshow", sync);
    };
  }, []);

  return (
    <main className="landing">
      <header className="site-header">
        <a className="site-brand" href="/">
          Notes<span> / your words, kept simple</span>
        </a>
        <nav>
          <a href="#features">Features</a>
          <a href="#pricing">Pricing</a>
          <a href="#guides">Guides</a>
          {hasSession ? <a className="button-link primary" href="/app">Open workspace</a> : <>
          <a href="/login">Log in</a>
          <a className="button-link primary" href="/register">
            Register
          </a>
          </>}
        </nav>
      </header>
      <section className="hero">
        <p className="eyebrow">A QUIET PLACE FOR YOUR IDEAS</p>
        <h1>
          Write it down.
          <br />
          <em>Make it yours.</em>
        </h1>
        <p className="hero-copy">
          A cloud workspace for Markdown notes. Keep your writing organised, revisit every version,
          and share what matters.
        </p>
        <div className="hero-actions">
          <a className="button-link primary" href="/app">Open workspace →</a>
          {!hasSession && <a className="button-link" href="/register">Start your notebook ↗</a>}
        </div>
        <p className="subtle">Web · CLI · MCP — one workspace, wherever you work.</p>
        <div className="note-sample" aria-label="Example Markdown note">
          <div className="sample-bar">
            <span>notes / everyday.md</span>
            <span>Markdown</span>
          </div>
          <p className="sample-date">A LITTLE SPACE TO THINK</p>
          <h2>Good ideas start with a note.</h2>
          <p>
            Capture a thought. Connect the pieces.
            <br />
            Come back when you're ready.
          </p>
          <ul>
            <li>Keep the things you want to remember</li>
            <li>Find the version you need</li>
            <li>Share a finished thought</li>
          </ul>
          <span className="sample-tag"># a work in progress</span>
        </div>
      </section>
      <section id="features" className="features">
        <div>
          <p className="eyebrow">LESS FRICTION. MORE WRITING.</p>
          <h2>
            Small tools.
            <br />
            Room for big ideas.
          </h2>
        </div>
        <article>
          <span>01 / WRITE</span>
          <h3>Plain text, beautifully useful</h3>
          <p>
            Markdown editing and preview, folders and fast search. Your notes stay readable and
            portable.
          </p>
        </article>
        <article>
          <span>02 / REVISIT</span>
          <h3>A history you can return to</h3>
          <p>
            Commit your changes, inspect differences and restore previous versions whenever you need
            them.
          </p>
        </article>
        <article>
          <span>03 / CONNECT</span>
          <h3>Made for your workflow</h3>
          <p>
            Use the browser, CLI or MCP. Import and export ZIP archives, and publish committed notes
            with a link.
          </p>
        </article>
      </section>
      <section id="pricing" className="pricing">
        <div>
          <p className="eyebrow">ONE SIMPLE PLAN</p>
          <h2>
            A home for your notes.
            <br />A small monthly price.
          </h2>
          <p>All the essentials, with no complicated tiers.</p>
        </div>
        <article className="plan-card">
          <span>NOTES MONTHLY</span>
          <h3>
            HK$10 <small>/ month</small>
          </h3>
          <p>
            Pay HKD 10/month by card or prepaid balance. Automatically renews until cancelled. Card
            checkout shows applicable taxes.
          </p>
          <ul>
            <li>Up to 1,000 Markdown notes</li>
            <li>Version history, search and public sharing</li>
            <li>Web, CLI and MCP access</li>
            <li>ZIP import and export</li>
          </ul>
          <a className="button-link primary" href={hasSession ? "/billing" : "/register"}>
            {hasSession ? "Manage subscription →" : "Create account & subscribe →"}
          </a>
          {!hasSession && <p className="subtle">
            Register first, then subscribe by card or top up and enable a balance subscription.
          </p>}
        </article>
      </section>
      <HomeGuides />
      <section className="faq">
        <h2>A few useful details.</h2>
        <details>
          <summary>When can I start using Notes?</summary>
          <p>
            After registration, subscribe to activate your workspace. Administrator activation is
            also available.
          </p>
        </details>
        <details>
          <summary>Can I cancel?</summary>
          <p>
            Yes. Open Billing to manage your subscription. You keep access for the paid period.
            After it ends, the account returns to pending; your notes remain stored.
          </p>
        </details>
        <details>
          <summary>What if a renewal payment fails?</summary>
          <p>
            Access lasts until the paid period ends. Update your payment method through Billing to
            resume. A failed payment does not add a new month.
          </p>
        </details>
      </section>
      <LegalFooter />
    </main>
  );
}

type BillingStatus = {
  user: PublicUser;
  status: string | null;
  currentPeriodEnd: string | null;
  cardPeriodEnd: string | null;
  active: boolean;
  manualAccess: boolean;
  hasCustomer: boolean;
  enabled: boolean;
  cancelAt: string | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: string | null;
  wallet: {
    balance: number;
    currency: string;
    autoRenew: boolean;
    periodEnd: string | null;
    enabled: boolean;
  };
};
type Ledger = { id: string; amount: number; balanceAfter: number; kind: string; createdAt: string };
type Topup = { id: string; amount: number; status: string; reversed: number };
const money = (amount: number) =>
  new Intl.NumberFormat("en-HK", { style: "currency", currency: "HKD" }).format(amount / 100);
export function BillingPage() {
  const token = window.localStorage.getItem(tokenKey);
  const query = new URLSearchParams(location.search);
  const topupId = query.get("topup");
  const success = query.get("checkout") === "success";
  const [data, setData] = useState<BillingStatus | null>(null);
  const [email, setEmail] = useState("");
  const [amount, setAmount] = useState(
    () => window.sessionStorage.getItem("notes-topup-amount") ?? "30"
  );
  const [message, setMessage] = useState(
    query.get("checkout") === "cancelled"
      ? "Checkout cancelled. No balance is credited until payment is confirmed."
      : ""
  );
  const [busy, setBusy] = useState(false);
  const [transactions, setTransactions] = useState<Ledger[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [topup, setTopup] = useState<Topup | null>(null);
  const [requestId, setRequestId] = useState(
    () => window.sessionStorage.getItem("notes-topup-request") ?? crypto.randomUUID()
  );
  async function refresh() {
    const next = await apiJson<BillingStatus>("/api/billing/status", { token });
    setData(next);
    const ledger = await apiJson<{ transactions: Ledger[]; nextCursor: string | null }>(
      "/api/billing/wallet/transactions",
      { token }
    );
    setTransactions(ledger.transactions);
    setCursor(ledger.nextCursor);
  }
  useEffect(() => {
    if (!token) {
      window.location.replace("/login");
      return;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    async function load() {
      try {
        const next = await apiJson<BillingStatus>("/api/billing/status", { token });
        const ledger = await apiJson<{ transactions: Ledger[]; nextCursor: string | null }>(
          "/api/billing/wallet/transactions",
          { token }
        );
        const order = topupId
          ? await apiJson<Topup>("/api/billing/topups/" + encodeURIComponent(topupId), { token })
          : null;
        if (stopped) return;
        setData(next);
        setEmail(next.user.email ?? "");
        setTransactions(ledger.transactions);
        setCursor(ledger.nextCursor);
        setTopup(order);
        if (order?.status === "paid") {
          window.sessionStorage.removeItem("notes-topup-request");
          setRequestId(crypto.randomUUID());
          setMessage(
            "Top-up confirmed. " +
              money(order.amount) +
              " credited. " +
              (next.wallet.autoRenew
                ? "Balance renewal remains enabled."
                : "Choose balance subscription to activate monthly renewal.")
          );
        } else if (order && ["failed", "expired"].includes(order.status)) {
          window.sessionStorage.removeItem("notes-topup-request");
          setRequestId(crypto.randomUUID());
          setMessage("This top-up " + order.status + ". No credit was added.");
        } else if (
          (order?.status === "pending" && query.get("checkout") !== "cancelled") ||
          (success && !next.active)
        ) {
          setMessage(
            attempts < 20
              ? "Confirming payment… You can safely return later."
              : "Payment confirmation is taking longer than expected. Refresh later; do not pay again."
          );
          if (++attempts < 20) timer = setTimeout(() => void load(), 1500);
        } else if (success) setMessage("Payment confirmed. Your workspace is ready.");
      } catch (error) {
        if (!stopped) setMessage(toMessage(error));
      }
    }
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
    // Query parameters are stable for this page load.
  }, [token, topupId, success]);
  async function action(path: string, method: "POST" | "DELETE" = "POST", body?: unknown) {
    setBusy(true);
    setMessage("");
    try {
      const result = await apiJson<{ url?: string; token?: string }>(path, { method, token, body });
      if (result.token) {
        window.localStorage.setItem(tokenKey, result.token);
        window.location.href = "/app";
      } else if (result.url) window.location.href = result.url;
      else {
        await refresh();
        setMessage(
          method === "DELETE"
            ? "Balance renewal cancelled. Paid access is retained."
            : "Balance subscription enabled."
        );
      }
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function saveEmail() {
    setBusy(true);
    try {
      await apiJson("/api/billing/email", { method: "PUT", token, body: { email } });
      await refresh();
      setMessage("Email saved.");
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function loadMore() {
    setBusy(true);
    try {
      const next = await apiJson<{ transactions: Ledger[]; nextCursor: string | null }>(
        "/api/billing/wallet/transactions?before=" + cursor,
        { token }
      );
      setTransactions((rows) => [...rows, ...next.transactions]);
      setCursor(next.nextCursor);
    } catch (error) {
      setMessage(toMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const cancellationScheduled = Boolean(data?.cancelAtPeriodEnd || data?.cancelAt);
  const walletPaid = Boolean(
    data?.wallet.periodEnd && new Date(data.wallet.periodEnd) > new Date()
  );
  const cardPaid = Boolean(data?.cardPeriodEnd && new Date(data.cardPeriodEnd) > new Date());
  const cardExists = Boolean(
    data?.status && !["canceled", "incomplete_expired"].includes(data.status)
  );
  const validAmount = /^\d+$/.test(amount) && Number(amount) >= 10 && Number(amount) <= 1000;
  return (
    <div className="public-account-site">
      <main className="billing-layout">
        <a href="/">← Notes home</a>
        <section className="billing-card">
          <p className="eyebrow">YOUR ACCOUNT</p>
          <h1>Subscription &amp; access</h1>
          {data ? (
            <>
              <p>
                {data.user.username} ·{" "}
                <strong>{data.active ? "Active" : "Pending activation"}</strong>
              </p>
              <p>
                {data.manualAccess
                  ? "Administrator activation is enabled for your account."
                  : data.wallet.autoRenew
                    ? "Balance subscription · HKD 10/month · automatically renews from balance"
                    : data.status === "canceled"
                      ? "Subscription cancelled · no further renewal"
                      : cancellationScheduled
                        ? "Cancellation scheduled · no further renewal"
                        : cardExists
                          ? "Card subscription · HKD 10/month · automatically renews until cancelled"
                          : walletPaid
                            ? "Balance renewal cancelled · paid access retained"
                            : "Choose card or balance subscription · HKD 10/month"}
              </p>
              {data.currentPeriodEnd && (
                <p>Paid access until {new Date(data.currentPeriodEnd).toLocaleString()}</p>
              )}
              {data.cancelAt && data.status !== "canceled" && (
                <p>Cancellation effective on {new Date(data.cancelAt).toLocaleString()}</p>
              )}
              {cancellationScheduled && data.active && !data.manualAccess && (
                <p className="notice">
                  Your workspace remains available until the paid period ends. It will then return
                  to pending unless you subscribe again.
                </p>
              )}
              {data.status && <p>Subscription: {data.status}</p>}
              <label>
                Email
                <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </label>
              <button disabled={busy || !email} onClick={() => void saveEmail()}>
                Save email
              </button>
              {!data.enabled && (
                <p>
                  Online payments are not available yet. Administrator activation remains available.
                </p>
              )}
              <PolicyNotice />
              <div className="billing-actions">
                {data.active && (
                  <button
                    className="primary"
                    disabled={busy}
                    onClick={() => void action("/api/billing/workspace-session")}
                  >
                    Open workspace
                  </button>
                )}
                {!cardExists && !data.manualAccess && (
                  <button
                    className="primary"
                    disabled={
                      busy ||
                      !data.enabled ||
                      !data.user.email ||
                      data.wallet.autoRenew ||
                      walletPaid
                    }
                    onClick={() => void action("/api/billing/checkout-session")}
                  >
                    Subscribe · HKD 10/month
                  </button>
                )}
                {data.hasCustomer && (
                  <button
                    disabled={busy || !data.enabled}
                    onClick={() => void action("/api/billing/portal-session")}
                  >
                    Manage subscription
                  </button>
                )}
                <button disabled={busy} onClick={() => window.location.reload()}>
                  Refresh status
                </button>
              </div>
              <section className="wallet-section" aria-label="Balance">
                <h2>
                  Balance <span>{money(data.wallet.balance)}</span>
                </h2>
                <p>
                  Top up once, then use your balance for monthly subscriptions. Balance never
                  expires and cannot be transferred or withdrawn.
                </p>
                {data.wallet.balance < 0 && (
                  <p className="notice">
                    A refund or dispute has made your balance negative. Top up enough to cover it
                    and the next HKD 10 renewal.
                  </p>
                )}
                {data.wallet.autoRenew && data.wallet.balance < 1000 && (
                  <p className="notice">
                    Your balance is below HKD 10. Top up before your next renewal to keep access.
                  </p>
                )}
                <div className="billing-actions">
                  {[10, 30, 100].map((value) => (
                    <button
                      key={value}
                      disabled={busy}
                      onClick={() => {
                        setAmount(String(value));
                        const key = crypto.randomUUID();
                        setRequestId(key);
                        window.sessionStorage.removeItem("notes-topup-request");
                      }}
                    >
                      HKD {value}
                    </button>
                  ))}
                </div>
                <label>
                  Top-up amount (HKD)
                  <input
                    type="number"
                    min="10"
                    max="1000"
                    step="1"
                    value={amount}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setRequestId(crypto.randomUUID());
                      window.sessionStorage.removeItem("notes-topup-request");
                    }}
                  />
                </label>
                <p className="subtle">
                  Whole HKD amounts from 10 to 1000. HKD 1 paid adds HKD 1 balance. Top-up alone
                  does not start a subscription.
                </p>
                <button
                  disabled={busy || !validAmount || !data.wallet.enabled || !data.user.email}
                  onClick={() => {
                    window.sessionStorage.setItem("notes-topup-request", requestId);
                    window.sessionStorage.setItem("notes-topup-amount", amount);
                    void action("/api/billing/topups/checkout-session", "POST", {
                      amount: Number(amount) * 100,
                      requestId
                    });
                  }}
                >
                  Top up with Stripe
                </button>
                {topup && (
                  <p>
                    Top-up: {topup.status} · {money(topup.amount)}
                    {topup.reversed > 0 ? " · reversed " + money(topup.reversed) : ""}
                  </p>
                )}
                <p className="subtle">
                  By subscribing or resuming renewal, you accept the <a href="/terms">Terms of Service</a>
                  {" "}and authorize HKD 10 monthly deductions. Subscription deductions are non-refundable,
                  subject to the exceptions in our <a href="/refunds">Refund Policy</a>.
                </p>
                <div className="billing-actions">
                  {data.wallet.autoRenew ? (
                    <button
                      disabled={busy}
                      onClick={() => void action("/api/billing/wallet/subscription", "DELETE")}
                    >
                      Cancel balance renewal
                    </button>
                  ) : (
                    <button
                      className="primary"
                      disabled={
                        busy ||
                        !data.wallet.enabled ||
                        cardExists ||
                        cardPaid ||
                        data.manualAccess ||
                        (!walletPaid && data.wallet.balance < 1000)
                      }
                      onClick={() => void action("/api/billing/wallet/subscription")}
                    >
                      {walletPaid
                        ? "Resume balance renewal"
                        : "Subscribe with balance · HKD 10/month"}
                    </button>
                  )}
                </div>
                <p className="subtle">
                  Balance renewal never charges your card. Insufficient balance pauses access at
                  expiry; a sufficient top-up resumes an enabled balance subscription from that
                  time. To switch payment methods, cancel renewal and wait until paid access and the
                  previous subscription have ended.
                </p>
                <h3>Balance history</h3>
                {transactions.length ? (
                  <div className="wallet-history">
                    <table>
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Type</th>
                          <th>Amount</th>
                          <th>Balance</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transactions.map((row) => (
                          <tr key={row.id}>
                            <td>{new Date(row.createdAt).toLocaleString()}</td>
                            <td>
                              {row.kind === "reversal"
                                ? "Refund / dispute"
                                : row.kind === "topup"
                                  ? "Top-up"
                                  : "Subscription"}
                            </td>
                            <td>{money(row.amount)}</td>
                            <td>{money(row.balanceAfter)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p>No balance transactions yet.</p>
                )}
                {cursor && (
                  <button disabled={busy} onClick={() => void loadMore()}>
                    Load more transactions
                  </button>
                )}
              </section>
              <p className="subtle">
                Cancelling stops future renewals; existing paid access lasts until the date shown.
                Expiry preserves your notes. Your first card subscription payment has a 7-day
                no-questions-asked refund window. Renewals and balance subscription deductions are
                excluded. Contact support for a card payment refund or a refund of unused prepaid
                balance under our <a href="/refunds">Refund Policy</a>. Successful card refunds end
                the associated subscription and access; top-up refunds reduce your balance.
              </p>
            </>
          ) : (
            <p>Loading account…</p>
          )}
          {message && (
            <p role="status" className="message">
              {message}
            </p>
          )}
          <button
            className="ghost"
            onClick={() => {
              void apiJson("/api/auth/logout", { method: "POST", token }).finally(() => {
                window.localStorage.removeItem(tokenKey);
                window.location.href = "/login";
              });
            }}
          >
            Logout
          </button>
        </section>
      </main>
      <LegalFooter />
    </div>
  );
}
