import type { ReactNode } from "react";

export const legalContact = {
  service: "Notes",
  email: "cowiejulewbfwo@gmail.com"
};

const updated = "25 September 2026";

const legalLinks = [
  { href: "/terms", label: "Terms of Service" },
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/refunds", label: "Refund Policy" },
  { href: "/contact", label: "Contact" }
];

export function LegalFooter() {
  return (
    <footer className="legal-footer">
      <a className="site-brand" href="/">
        Notes
      </a>
      <nav aria-label="Legal and contact">
        {legalLinks.map((link) => (
          <a key={link.href} href={link.href}>
            {link.label}
          </a>
        ))}
      </nav>
      <a href={`mailto:${legalContact.email}`}>{legalContact.email}</a>
    </footer>
  );
}

export function PolicyNotice() {
  return (
    <p className="policy-notice">
      Before registering or subscribing, please review our{" "}
      <a href="/terms" target="_blank" rel="noreferrer">
        Terms of Service
      </a>
      ,{" "}
      <a href="/privacy" target="_blank" rel="noreferrer">
        Privacy Policy
      </a>{" "}
      and{" "}
      <a href="/refunds" target="_blank" rel="noreferrer">
        Refund Policy
      </a>
      . For questions,{" "}
      <a href="/contact" target="_blank" rel="noreferrer">
        contact us
      </a>
      .
    </p>
  );
}

function LegalLayout({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="legal-site">
      <header className="site-header">
        <a className="site-brand" href="/">
          Notes
        </a>
        <nav>
          <a href="/">Home</a>
          <a href="/login">Log in</a>
          <a className="button-link primary" href="/register">
            Register
          </a>
        </nav>
      </header>
      <main className="legal-document">
        <p className="eyebrow">NOTES / INFORMATION</p>
        <h1>{title}</h1>
        <p className="legal-updated">Last updated: {updated}</p>
        {children}
      </main>
      <LegalFooter />
    </div>
  );
}

const contactLink = <a href="/contact">contact us</a>;

export function TermsPage() {
  return (
    <LegalLayout title="Terms of Service">
      <p>
        Notes at notes.bosschat.de is operated by an independent individual developer. In these
        terms, “Notes”, “we” and “us” refer to this independently operated service. These terms
        govern your use of Notes. For questions about the service, {contactLink} by email. By
        registering or using Notes, you agree to these terms.
      </p>
      <h2>What Notes provides</h2>
      <p>
        Notes is an online Markdown workspace with folders, version history, search, import and
        export, and optional public sharing. A paid subscription grants access to the service for
        the period shown in Billing. Notes may also be activated manually by an administrator.
      </p>
      <h2>Your account</h2>
      <p>
        You must be legally able to enter into a subscription agreement, or have permission from a
        parent or legal guardian where required. Provide accurate registration information and keep
        your password and access token private. You are responsible for activity under your account.
        Tell us promptly if you suspect unauthorized access. Accounts may be set to pending when
        paid access expires; existing notes are not automatically deleted on expiry.
      </p>
      <h2>Price, renewal and cancellation</h2>
      <p>
        The current plan is HKD 10 per month, billed automatically until cancelled. Any applicable
        tax and the final amount are shown by Stripe before payment. Manage payment methods or
        cancel through the Billing page and Stripe customer portal. Cancelling a renewal keeps
        access through the end of the already paid period; after that the account returns to pending
        unless access is renewed or granted by an administrator. Cancelling does not itself refund a
        completed payment. See the <a href="/refunds">Refund Policy</a>.
      </p>
      <h2>Your content and public sharing</h2>
      <p>
        You keep ownership of content you upload or write. You permit us to store, process and
        display it to provide Notes. A note you choose to publish through the sharing feature is
        accessible to anyone with its public link until you unpublish it or the share becomes
        invalid. Do not upload content you lack the right to use, unlawful content, or material that
        infringes others' rights.
      </p>
      <h2>Acceptable use</h2>
      <p>
        Do not misuse the service, interfere with its operation, bypass access limits, or attempt to
        access another user's data. We may restrict access where necessary to protect the service,
        users or legal obligations. We will handle account and content requests through the{" "}
        {contactLink} page.
      </p>
      <h2>Ending your use</h2>
      <p>
        You can stop using Notes and cancel renewal at any time. To request account deletion,
        contact support and export any notes you want to keep first. Deleting your account and
        cancelling your subscription are separate requests; tell us if you need both. If we
        discontinue the service, we will aim to give reasonable notice, an opportunity to export
        your notes, and a refund for prepaid service we cannot provide.
      </p>
      <h2>Availability and changes</h2>
      <p>
        We aim to keep Notes available and secure, but maintenance, network failures and third-party
        services can interrupt access. We may improve or change the service and these terms.
        Material changes will be posted here with an updated date. Your mandatory rights under
        applicable law are unaffected.
      </p>
      <h2>Resolving concerns</h2>
      <p>
        Please email support first with any complaint so we can try to resolve it. These terms do
        not exclude rights or remedies that cannot be waived under applicable consumer law, or
        prevent you from contacting a competent consumer authority or court.
      </p>
      <h2>Questions</h2>
      <p>
        For account, service or legal questions, see our {contactLink} page. For how personal data
        is handled, see the <a href="/privacy">Privacy Policy</a>.
      </p>
    </LegalLayout>
  );
}

export function PrivacyPage() {
  return (
    <LegalLayout title="Privacy Policy">
      <p>
        Notes is operated by an independent individual developer who is responsible for the personal
        data handled by the service as described below. For privacy questions and requests, use the{" "}
        <a href="/contact">Contact</a> page.
      </p>
      <h2>Information we handle</h2>
      <p>
        When you register, we store your username, email address, password hash, account status and
        session records. We store the notes, folders, files and version history you create, and
        records of shares you publish. For subscribers, we store Stripe customer and subscription
        identifiers, subscription status and paid-period dates. Our servers and reverse proxy may
        record technical request information needed for operation and security.
      </p>
      <h2>How we use it</h2>
      <p>
        We use this information to authenticate you, operate and secure your workspace, save and
        restore notes, provide public sharing when you request it, manage subscriptions and respond
        to support requests. We do not use your note content for advertising.
      </p>
      <h2>Reasons for processing</h2>
      <p>
        Where data protection law requires a legal basis, we process data as necessary to provide
        the service you request, meet legal obligations, and pursue legitimate interests in service
        security and abuse prevention. Where consent is required for an optional activity, we will
        ask for it and allow you to withdraw it.
      </p>
      <h2>Payments and other providers</h2>
      <p>
        Checkout and subscription management are hosted by Stripe. We send Stripe your email and
        account identifier to link the payment to your account. Stripe processes payment details,
        billing information, fraud checks and receipts under its own{" "}
        <a href="https://stripe.com/privacy" target="_blank" rel="noreferrer">
          Privacy Policy
        </a>
        . Notes does not receive or store your full card number. Stripe Managed Payments may use
        Link for transaction support.
      </p>
      <h2>Sharing and access</h2>
      <p>
        Your private workspace is associated with your account. When you publish a note, its
        committed content is available publicly through its share URL; do not publish confidential
        information. We may disclose information to service providers who help run Notes, or where
        required by law. We do not sell personal information.
      </p>
      <h2>Storage and security</h2>
      <p>
        Notes stores account data in a database and workspace content on the server. Passwords are
        stored as salted hashes and session tokens as hashes; the browser stores your login token
        locally. We use HTTPS for the public site. No online service can promise absolute security.
      </p>
      <h2>Browser storage</h2>
      <p>
        Notes uses browser local storage to keep your login session available between visits.
        Logging out removes the stored login token. You can also clear local storage in your
        browser, which will sign you out of Notes. Stripe and Link may use cookies and similar
        technologies on their own payment pages under their own policies.
      </p>
      <h2>Retention and your choices</h2>
      <p>
        We keep account and workspace data while the account remains in use, and may retain records
        needed for security, billing or legal obligations. Cancelling a subscription or letting
        access expire does not automatically delete notes. You can export your workspace as a ZIP
        file. To request access, correction or deletion of your personal data or account, use the{" "}
        <a href="/contact">Contact</a> page. We will assess requests under applicable law and
        explain any records that must be retained. You can unpublish shared notes in the app.
        Depending on applicable law, you may also request data portability, restriction of
        processing, or object to processing, and complain to your local data protection authority.
        We may need to verify your account ownership before acting on a request. We aim to respond
        within 30 days, or within any shorter legally required period.
      </p>
      <h2>Changes</h2>
      <p>
        We will update this page if our data practices change and show the new update date. Contact
        us with questions or privacy requests.
      </p>
    </LegalLayout>
  );
}

export function RefundsPage() {
  return (
    <LegalLayout title="Refund Policy">
      <p>
        Notes is a digital subscription billed monthly in HKD. The final charge, including any
        applicable tax, appears at Stripe Checkout before you confirm payment.
      </p>
      <h2>Cancellation and paid access</h2>
      <p>
        You can cancel future renewal through the Billing page and Stripe customer portal at any
        time. Cancellation stops future recurring charges and your account remains available through
        the current paid period. Cancellation by itself is not a refund of that payment.
      </p>
      <h2>First subscription: 7-day refund</h2>
      <p>
        If Notes does not meet your needs, request a full refund within 7 calendar days of your
        first subscription payment. You do not need to demonstrate a service fault. This offer
        applies to the first subscription payment for each customer, not to each renewal or repeated
        signup.
      </p>
      <h2>Renewals and service problems</h2>
      <p>
        Renewal payments are generally non-refundable once the new billing period starts, and we do
        not normally issue partial refunds for unused days when you cancel. Please cancel before the
        next renewal to avoid another charge. These limits do not apply to duplicate or incorrect
        charges, a successful payment that did not provide access, or a material service failure we
        cannot resolve. Contact us promptly about these issues; we will review the charge and
        provide a full or proportionate refund as appropriate to the affected service.
      </p>
      <h2>How to request a refund</h2>
      <p>
        Email <a href={`mailto:${legalContact.email}`}>{legalContact.email}</a> or use the support
        link in your Stripe/Link payment receipt. Include your account email, payment date, amount,
        receipt or transaction reference if available, and a brief reason. Never send your password
        or full payment-card number. For the 7-day offer, the date you send the request determines
        whether it is within the deadline.
      </p>
      <h2>Review and payment timing</h2>
      <p>
        We aim to reply within 3 business days and complete our review within 5 business days after
        receiving the information needed to identify the payment. If a provider investigation takes
        longer, we will let you know. Approved refunds are returned to the original payment method
        where supported. After the payment provider issues a refund, it typically takes 5–10
        business days to appear, depending on the provider and your bank; this is an estimate, not a
        guaranteed arrival date.
      </p>
      <h2>Access after a refund</h2>
      <p>
        A full refund may end access for the refunded period. We will explain any effect on your
        subscription when handling the request. A refund request alone does not cancel future
        renewals: cancel through Billing or ask support for help cancelling. Export any notes you
        need before your paid access ends.
      </p>
      <h2>Stripe Managed Payments</h2>
      <p>
        Payments are processed through Stripe Managed Payments, with Stripe acting as merchant of
        record for eligible transactions. Stripe/Link may handle payment support and refunds under
        its own{" "}
        <a
          href="https://support.link.com/questions/sold-through-link-refunds"
          target="_blank"
          rel="noreferrer"
        >
          refund rules
        </a>
        . Stripe may grant refunds to resolve disputes independently of this policy. Any more
        favorable mandatory consumer rights or applicable Stripe/Link refund rights remain
        available; this policy does not limit them. A refund may change subscription access; contact
        us if your account status is incorrect.
      </p>
      <h2>Help</h2>
      <p>
        For a service problem, charge question or refund request, use the{" "}
        <a href="/contact">Contact</a> page. You can also use the support link on your Stripe/Link
        receipt for transaction-specific assistance.
      </p>
    </LegalLayout>
  );
}

export function ContactPage() {
  return (
    <LegalLayout title="Contact">
      <p>
        Notes is a service operated and maintained by an independent individual developer. For
        product support, account access, privacy questions or refund requests, contact the developer
        through the support email below:
      </p>
      <address>
        <strong>{legalContact.service} support</strong>
        <br />
        <a href={`mailto:${legalContact.email}`}>{legalContact.email}</a>
      </address>
      <p>
        Please include your Notes username or account email and a brief description. Do not send
        your password or full payment-card number.
      </p>
      <h2>Response time</h2>
      <p>
        Email is our primary support channel. We aim to reply within 3 business days (Monday–Friday,
        excluding public holidays). Support is not staffed around the clock. Refund review and
        payment timing are explained in our <a href="/refunds">Refund Policy</a>.
      </p>
      <h2>Billing support</h2>
      <p>
        For a specific Stripe/Link transaction, you can also use the support link in your payment
        receipt. You can manage your subscription and payment method from{" "}
        <a href="/billing">Billing</a>.
      </p>
    </LegalLayout>
  );
}
