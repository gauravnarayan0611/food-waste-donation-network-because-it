import React, { useCallback, useEffect, useMemo, useState } from "react";

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");

async function apiRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...options,
      credentials: "include",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("Cannot reach FoodBridge API. Check the backend URL and that the server is running.");
    }
    throw error;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`FoodBridge API returned a non-JSON response (HTTP ${response.status}).`);
  }
  if (!response.ok || !payload.success) {
    const error = new Error(payload.error?.message || "The request could not be completed.");
    error.status = response.status;
    error.code = payload.error?.code;
    throw error;
  }
  return payload.data;
}

function AdminApp() {
  const [user, setUser] = useState(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [donations, setDonations] = useState([]);
  const [ngos, setNgos] = useState([]);
  const [overview, setOverview] = useState({});
  const [notifications, setNotifications] = useState([]);
  const [toast, setToast] = useState("");
  const [error, setError] = useState("");

  const showToast = useCallback((message) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 3800);
  }, []);

  const refreshDashboard = useCallback(async () => {
    const [nextDonations, nextNgos, nextOverview, nextNotifications] = await Promise.all([
      apiRequest("/api/v1/donations"),
      apiRequest("/api/v1/admin/ngos"),
      apiRequest("/api/v1/overview"),
      apiRequest("/api/v1/notifications")
    ]);
    setDonations(nextDonations);
    setNgos(nextNgos);
    setOverview(nextOverview);
    setNotifications(nextNotifications);
  }, []);

  useEffect(() => {
    let active = true;
    apiRequest("/api/v1/auth/session")
      .then(async ({ user: sessionUser }) => {
        if (!active) return;
        if (sessionUser?.role === "Admin") {
          setUser(sessionUser);
          await refreshDashboard();
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError.message);
      })
      .finally(() => {
        if (active) setSessionChecked(true);
      });
    return () => { active = false; };
  }, [refreshDashboard]);

  useEffect(() => {
    if (!user) return undefined;
    let cancelled = false;
    let socket;
    const connect = async () => {
      if (typeof window.io !== "function") {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = `${apiBaseUrl}/socket.io/socket.io.js`;
          script.onload = resolve;
          script.onerror = () => reject(new Error("Could not load live updates from the FoodBridge API."));
          document.head.appendChild(script);
        });
      }
      if (cancelled) return;
      socket = window.io(apiBaseUrl || window.location.origin, { withCredentials: true });
      socket.on("notification", (item) => {
        setNotifications((items) => [{ ...item, id: `live-${Date.now()}` }, ...items]);
        showToast(item.text);
      });
      ["ngo:verified", "donation:submitted", "donation:approved", "assignment:available", "assignment:cancelled"]
        .forEach((event) => socket.on(event, () => {
          refreshDashboard().catch((refreshError) => showToast(`Could not refresh dashboard: ${refreshError.message}`));
        }));
      socket.on("connect_error", () => showToast("Live updates are disconnected. Check the backend and allowed origins."));
    };
    connect().catch((connectionError) => showToast(connectionError.message));
    return () => {
      cancelled = true;
      socket?.disconnect();
    };
  }, [user, refreshDashboard, showToast]);

  const pendingDonations = useMemo(() => donations.filter((item) => item.approvalStatus === "PENDING"), [donations]);
  const activeDonations = useMemo(() => donations.filter((item) => item.status !== "Removed"), [donations]);
  const pendingNgos = useMemo(() => ngos.filter((ngo) => !ngo.verified), [ngos]);

  async function login(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { user: signedIn } = await apiRequest("/api/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: email.trim().toLowerCase(), password, role: "Admin" })
      });
      if (signedIn.role !== "Admin") throw new Error("This account does not have Admin access.");
      setUser(signedIn);
      setPassword("");
      await refreshDashboard();
    } catch (loginError) {
      setError(loginError.status === 401
        ? "Admin sign-in failed. Check your provisioned Admin email and password."
        : loginError.message);
    } finally {
      setBusy(false);
      setSessionChecked(true);
    }
  }

  async function runAction(action, successMessage) {
    setBusy(true);
    try {
      await action();
      await refreshDashboard();
      showToast(successMessage);
    } catch (actionError) {
      setError(actionError.message);
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    setBusy(true);
    try {
      await apiRequest("/api/v1/auth/logout", { method: "POST" });
      setUser(null);
      setDonations([]);
      setNgos([]);
      setNotifications([]);
      setError("");
    } catch (logoutError) {
      setError(`Could not log out: ${logoutError.message}`);
    } finally {
      setBusy(false);
    }
  }

  if (!sessionChecked) {
    return <main className="admin-loading"><span className="admin-spinner" />Connecting to FoodBridge…</main>;
  }

  if (!user) {
    return <main className="admin-login-page">
      <form className="admin-login-card" onSubmit={login}>
        <div className="admin-brand-mark">FB</div>
        <p className="admin-eyebrow">FoodBridge administration</p>
        <h1>Admin sign in</h1>
        <p className="admin-muted">Use the provisioned Admin account. Admin accounts cannot be registered here.</p>
        {error && <div className="admin-error" role="alert">{error}</div>}
        <label>Email<input type="email" autoComplete="username" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button className="admin-button primary" disabled={busy}>{busy ? "Signing in…" : "Sign in as Admin"}</button>
        <a className="admin-back-link" href={import.meta.env.VITE_FRONTEND_URL || "http://127.0.0.1:5174"}>Back to FoodBridge</a>
      </form>
      {toast && <div className="admin-toast" role="status">{toast}</div>}
    </main>;
  }

  return <main className="admin-app">
    <header className="admin-header">
      <a className="admin-brand" href="#dashboard"><span className="admin-brand-mark">FB</span><span><strong>FoodBridge</strong><small>Administration</small></span></a>
      <div className="admin-header-actions"><span>{user.name} · Admin</span><button className="admin-button outline" onClick={logout} disabled={busy}>Log out</button></div>
    </header>
    <div className="admin-main">
      <div className="admin-page-heading"><div><p className="admin-eyebrow">Control center</p><h1>Admin dashboard</h1><p className="admin-muted">Review NGO registrations and donor food requests.</p></div>
        <button className="admin-button outline" onClick={() => runAction(refreshDashboard, "Dashboard refreshed.")} disabled={busy}>Refresh</button></div>
      {error && <div className="admin-error" role="alert">{error}<button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}
      <section className="admin-stat-grid">
        <StatCard label="Registered users" value={overview.users || 0} />
        <StatCard label="Available donations" value={overview.availableDonations || 0} />
        <StatCard label="Meals delivered" value={overview.mealsDelivered || 0} />
        <StatCard label="Verified NGOs" value={overview.verifiedNgos || 0} />
      </section>
      <div className="admin-content-grid">
        <section className="admin-panel">
          <div className="admin-panel-heading"><div><p className="admin-eyebrow">Review queue</p><h2>NGO approvals <span className="admin-count">{pendingNgos.length}</span></h2></div></div>
          {pendingNgos.length ? <div className="admin-table-wrap"><table><thead><tr><th>Organization</th><th>City</th><th>Contact</th><th>Action</th></tr></thead>
            <tbody>{pendingNgos.map((ngo) => <tr key={ngo.id}><td>{ngo.name}</td><td>{ngo.city || "—"}</td><td>{ngo.email}<br />{ngo.phone || ""}</td>
              <td><button className="admin-button primary small" disabled={busy}
                onClick={() => runAction(() => apiRequest(`/api/v1/admin/ngos/${ngo.id}/approve`, { method: "PATCH" }), "NGO approved.")}>Approve</button></td></tr>)}</tbody>
          </table></div> : <EmptyState>No NGO accounts are waiting for approval.</EmptyState>}
        </section>
        <section className="admin-panel">
          <div className="admin-panel-heading"><div><p className="admin-eyebrow">Review queue</p><h2>Donation approvals <span className="admin-count">{pendingDonations.length}</span></h2></div></div>
          {pendingDonations.length ? <div className="admin-donation-list">{pendingDonations.map((donation) =>
            <DonationCard key={donation.id} donation={donation} busy={busy}
              onApprove={() => runAction(() => apiRequest(`/api/v1/admin/donations/${donation.id}/approve`, { method: "PATCH" }), "Donation approved. NGOs and riders have been notified.")}
              onRemove={() => runAction(() => apiRequest(`/api/v1/admin/donations/${donation.id}`, { method: "DELETE" }), "Donation request removed.")} />)}</div>
            : <EmptyState>No donor requests are waiting for approval.</EmptyState>}
        </section>
      </div>
      <section className="admin-panel admin-listings">
        <div className="admin-panel-heading"><div><p className="admin-eyebrow">Network activity</p><h2>Donation listings</h2></div></div>
        {activeDonations.length ? <div className="admin-donation-list">{activeDonations.map((donation) =>
          <article className="admin-listing-row" key={donation.id}>
            <div><strong>{donation.foodName}</strong><span>{donation.quantity} portions · {donation.category} · {donation.location}</span></div>
            <span className={`admin-status ${donation.approvalStatus === "PENDING" ? "pending" : donation.status === "Completed" ? "completed" : ""}`}>
              {donation.approvalStatus === "PENDING" ? "Pending approval" : donation.deliveryStatus || donation.status}</span>
            {!["Removed", "Completed"].includes(donation.status) && <button className="admin-button danger small" disabled={busy}
              onClick={() => runAction(() => apiRequest(`/api/v1/admin/donations/${donation.id}`, { method: "DELETE" }), "Listing removed.")}>Remove</button>}
          </article>)}</div> : <EmptyState>No donation listings found.</EmptyState>}
      </section>
      <section className="admin-panel admin-notifications">
        <div className="admin-panel-heading"><div><p className="admin-eyebrow">System updates</p><h2>Notifications</h2></div>
          {notifications.length > 0 && <button className="admin-button outline small" disabled={busy}
            onClick={() => runAction(() => apiRequest("/api/v1/notifications", { method: "DELETE" }), "Notifications cleared.")}>Clear all</button>}</div>
        {notifications.length ? notifications.slice(0, 8).map((notification) =>
          <div className="admin-notification" key={notification.id}>{notification.text}<time>{new Date(notification.at).toLocaleString()}</time></div>)
          : <EmptyState>No new notifications.</EmptyState>}
      </section>
    </div>
    {toast && <div className="admin-toast" role="status">{toast}</div>}
  </main>;
}

function StatCard({ label, value }) {
  return <article className="admin-stat-card"><span>{label}</span><strong>{Number(value).toLocaleString("en-IN")}</strong></article>;
}

function EmptyState({ children }) {
  return <div className="admin-empty-state">{children}</div>;
}

function DonationCard({ donation, onApprove, onRemove, busy }) {
  return <article className="admin-request-card">
    <div className="admin-request-heading"><div><p className="admin-eyebrow">{donation.category} · {donation.location}</p><h3>{donation.foodName}</h3></div>
      <span className="admin-status pending">Pending approval</span></div>
    <p>{donation.quantity} portions from {donation.donor?.name || "Food donor"}</p>
    <p className="admin-muted">{donation.address} · Pickup by {donation.pickupBefore}</p>
    {donation.instructions && <p className="admin-muted">Handling: {donation.instructions}</p>}
    <div className="admin-actions"><button className="admin-button primary" disabled={busy} onClick={onApprove}>Approve donation</button>
      <button className="admin-button danger" disabled={busy} onClick={onRemove}>Remove</button></div>
  </article>;
}

export default AdminApp;
