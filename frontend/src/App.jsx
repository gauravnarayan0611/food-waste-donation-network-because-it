import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleMarker, MapContainer, Popup, TileLayer, useMap } from "react-leaflet";
import foodBridgeLogo from "./assets/foodbridge-logo.png";

const cities = {
  Amritsar: { lat: 31.634, lng: 74.8723 },
  Jalandhar: { lat: 31.326, lng: 75.5762 },
  Ludhiana: { lat: 30.901, lng: 75.8573 },
  Chandigarh: { lat: 30.7333, lng: 76.7794 },
  Delhi: { lat: 28.6139, lng: 77.209 }
};

const navigation = ["home", "donor", "ngo", "rider", "map"];
const riderSections = ["overview", "available", "active", "history", "notifications"];
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL || "").replace(/\/$/, "");
const adminAppUrl = import.meta.env.VITE_ADMIN_URL || "http://127.0.0.1:5175";

function localDateTime(hoursAhead) {
  const date = new Date(Date.now() + hoursAhead * 60 * 60 * 1000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

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
      throw new Error("Cannot reach FoodBridge. Start MongoDB and run \"npm start\".");
    }
    throw error;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`FoodBridge returned a non-JSON response (HTTP ${response.status}).`);
  }
  if (!response.ok || !payload.success) {
    const error = new Error(payload.error?.message || "The request could not be completed.");
    error.status = response.status;
    error.code = payload.error?.code;
    throw error;
  }
  return payload.data;
}

function distanceKm(a, b) {
  if (!isValidCoordinates(a) || !isValidCoordinates(b)) return null;
  const radians = (value) => value * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const calc = Math.sin(dLat / 2) ** 2
    + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(calc), Math.sqrt(1 - calc));
}

function isValidCoordinates(value) {
  return value !== null && typeof value === "object"
    && Number.isFinite(value.lat) && value.lat >= -90 && value.lat <= 90
    && Number.isFinite(value.lng) && value.lng >= -180 && value.lng <= 180;
}

function coordinatesOrCity(coordinates, city) {
  return isValidCoordinates(coordinates) ? coordinates : cities[city];
}

function freshness(donation) {
  const hours = (new Date(donation.expiryTime) - Date.now()) / 3600000;
  if (hours <= 2) return { label: "Urgent", className: "urgent" };
  if (hours <= 6) return { label: "Medium", className: "medium" };
  return { label: "Fresh", className: "fresh" };
}

function statusClass(status) {
  if (["Available", "ACCEPTED", "PICKED_UP"].includes(status)) return "available";
  if (["Reserved", "DELIVERED"].includes(status)) return "reserved";
  if (["Completed", "COMPLETED"].includes(status)) return "completed";
  return "";
}

function EmptyState({ children }) {
  return <div className="empty-state">{children}</div>;
}

function Stat({ label, value }) {
  return <div className="stat"><strong>{value}</strong><span>{label}</span></div>;
}

function MapViewport({ points, fitRequest }) {
  const map = useMap();

  useEffect(() => {
    if (!points.length) {
      map.setView([30.9, 75.85], 7);
      return;
    }
    if (points.length === 1) {
      map.setView([points[0].lat, points[0].lng], 11);
      return;
    }
    map.fitBounds(points.map((point) => [point.lat, point.lng]), { padding: [36, 36], maxZoom: 12 });
  }, [map, points, fitRequest]);

  return null;
}

function App() {
  const [user, setUser] = useState(null);
  const [view, setView] = useState(() => {
    const requestedView = location.hash.slice(1);
    return navigation.includes(requestedView) ? requestedView : "home";
  });
  const [riderSection, setRiderSection] = useState("overview");
  const [donations, setDonations] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [verifiedNgos, setVerifiedNgos] = useState([]);
  const [metrics, setMetrics] = useState({});
  const [availableTasks, setAvailableTasks] = useState([]);
  const [riderTasks, setRiderTasks] = useState([]);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState("login");
  const [authRole, setAuthRole] = useState("Donor");
  const [authBusy, setAuthBusy] = useState(false);
  const [toastMessages, setToastMessages] = useState([]);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [donorFilter, setDonorFilter] = useState("All");
  const [ngoCity, setNgoCity] = useState("All");
  const [historySearch, setHistorySearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [mapFitRequest, setMapFitRequest] = useState(0);
  const [donationForm, setDonationForm] = useState({
    foodName: "", quantity: "", category: "Prepared Meals", location: "Amritsar",
    address: "", pickupBefore: new Date(Date.now() + 3 * 3600000).toTimeString().slice(0, 5),
    expiryTime: localDateTime(5), latitude: "", longitude: "", instructions: "", image: null
  });
  const socketRef = useRef(null);

  const toast = useCallback((message) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToastMessages((items) => [...items, { id, message }]);
    window.setTimeout(() => setToastMessages((items) => items.filter((item) => item.id !== id)), 3600);
  }, []);

  const refreshDashboardData = useCallback(async (activeUser = user) => {
    if (!activeUser) {
      setDonations([]);
      setNotifications([]);
      setAvailableTasks([]);
      setRiderTasks([]);
      return;
    }
    const [nextDonations, nextNotifications, overview, nextVerifiedNgos] = await Promise.all([
      apiRequest("/api/v1/donations"),
      apiRequest("/api/v1/notifications"),
      apiRequest("/api/v1/overview"),
      apiRequest("/api/v1/ngos/verified")
    ]);
    setDonations(nextDonations);
    setNotifications(nextNotifications);
    setMetrics(overview);
    setVerifiedNgos(nextVerifiedNgos);
    if (activeUser.role === "Rider") {
      const [available, mine] = await Promise.all([
        apiRequest("/api/v1/assignments/available"),
        apiRequest("/api/v1/assignments/my-tasks")
      ]);
      setAvailableTasks(available);
      setRiderTasks(mine);
    } else {
      setAvailableTasks([]);
      setRiderTasks([]);
    }
  }, []);

  const syncSession = useCallback(async () => {
    const { user: sessionUser } = await apiRequest("/api/v1/auth/session");
    if (sessionUser?.role === "Admin") {
      window.location.assign(adminAppUrl);
      return sessionUser;
    }
    setUser(sessionUser);
    if (sessionUser) {
      const nextView = sessionUser.role.toLowerCase();
      setView(nextView);
      if (location.hash !== `#${nextView}`) history.replaceState(null, "", `#${nextView}`);
    } else {
      setView("home");
      if (location.hash !== "#home") history.replaceState(null, "", "#home");
    }
    await refreshDashboardData(sessionUser);
    return sessionUser;
  }, [refreshDashboardData]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { user: sessionUser } = await apiRequest("/api/v1/auth/session");
        if (!active) return;
        if (sessionUser?.role === "Admin") {
          window.location.replace(adminAppUrl);
          return;
        }
        setUser(sessionUser);
        await refreshDashboardData(sessionUser);
      } catch (error) {
        if (error.status !== 401 && active) toast(error.message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, [refreshDashboardData, toast]);

  useEffect(() => {
    let syncing = false;
    const handleFocus = async () => {
      if (syncing || document.visibilityState !== "visible") return;
      syncing = true;
      try {
        const { user: sessionUser } = await apiRequest("/api/v1/auth/session");
        const sessionChanged = sessionUser?.id !== user?.id || sessionUser?.role !== user?.role;
        if (sessionChanged) {
          await syncSession();
          toast(sessionUser
            ? `This tab is now signed in as ${sessionUser.role}.`
            : "Your FoodBridge session ended in another tab. Please sign in again.");
        }
      } catch (error) {
        toast(`Could not verify your session: ${error.message}`);
      } finally {
        syncing = false;
      }
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleFocus);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleFocus);
    };
  }, [user, syncSession, toast]);

  useEffect(() => {
    const handleHash = () => {
      const next = location.hash.slice(1) || "home";
      if (navigation.includes(next)) setView(next);
    };
    window.addEventListener("hashchange", handleHash);
    return () => window.removeEventListener("hashchange", handleHash);
  }, []);

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      return undefined;
    }
    let cancelled = false;
    const connect = async () => {
      if (typeof window.io !== "function") {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = `${apiBaseUrl}/socket.io/socket.io.js`;
          script.onload = resolve;
          script.onerror = () => reject(new Error("Could not load live updates from the FoodBridge server."));
          document.head.appendChild(script);
        });
      }
      if (cancelled) return;
      const socket = window.io(apiBaseUrl || window.location.origin, { withCredentials: true });
      socketRef.current = socket;
      socket.on("notification", (item) => {
        setNotifications((items) => [{ ...item, id: `live-${Date.now()}` }, ...items]);
        toast(item.text);
      });
      [
        "donation:available", "donation:approved", "assignment:available", "assignment:assigned",
        "assignment:picked-up", "assignment:delivered", "assignment:completed",
        "assignment:cancelled", "ngo:verified", "donation:completed"
      ].forEach((event) => socket.on(event, () => {
        refreshDashboardData(user).catch((error) => toast(`Could not refresh data: ${error.message}`));
      }));
      socket.on("connect_error", () => toast("Live updates are disconnected. Check that the backend is running."));
    };
    connect().catch((error) => toast(error.message));
    return () => {
      cancelled = true;
      socketRef.current?.disconnect();
      socketRef.current = null;
    };
  }, [user, refreshDashboardData, toast]);

  const navigate = (next) => {
    if (!navigation.includes(next)) return;
    if (next === "rider" && user?.role !== "Rider") {
      openAuth("Rider");
      toast("Sign in as a delivery partner to continue.");
      return;
    }
    setView(next);
    setMobileMenuOpen(false);
    if (location.hash !== `#${next}`) history.pushState(null, "", `#${next}`);
  };

  function openAuth(role = "Donor") {
    setAuthRole(role);
    setAuthMode("login");
    setAuthOpen(true);
  }

  async function submitAuth(event) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const role = String(form.get("role"));
    const registering = authMode === "register";
    const body = {
      email: String(form.get("email")).trim().toLowerCase(),
      password: String(form.get("password")),
      role
    };
    if (registering) {
      body.name = String(form.get("name")).trim();
      body.city = String(form.get("city") || "").trim();
      body.address = String(form.get("address") || "").trim();
      body.phone = String(form.get("phone") || "").trim();
      const lat = String(form.get("latitude") || "");
      const lng = String(form.get("longitude") || "");
      if (lat || lng) body.coordinates = { lat: Number(lat), lng: Number(lng) };
    }
    setAuthBusy(true);
    try {
      const { user: loggedIn } = await apiRequest(`/api/v1/auth/${registering ? "register" : "login"}`, {
        method: "POST", body: JSON.stringify(body)
      });
      if (loggedIn.role === "Admin") {
        window.location.assign(adminAppUrl);
        return;
      }
      setUser(loggedIn);
      await refreshDashboardData(loggedIn);
      setAuthOpen(false);
      const nextView = loggedIn.role.toLowerCase();
      setView(nextView);
      if (location.hash !== `#${nextView}`) history.pushState(null, "", `#${nextView}`);
      toast(registering
        ? loggedIn.role === "NGO" ? "NGO account created and sent for admin approval." : "Account created."
        : `Welcome, ${loggedIn.name}.`);
    } catch (error) {
      if (!registering && role === "Admin" && error.status === 401) {
        toast("Admin sign-in failed. This email/password is not a provisioned Admin account. Create one with a different unused email using ADMIN_EMAIL and ADMIN_PASSWORD, then run npm run create-admin.");
      } else if (!registering && error.status === 401) {
        toast("Sign-in failed. Check your email, password, and selected role. If you haven't registered, choose Register first.");
      } else {
        toast(error.message);
      }
    } finally {
      setAuthBusy(false);
    }
  }

  async function logout() {
    try {
      await apiRequest("/api/v1/auth/logout", { method: "POST" });
      socketRef.current?.disconnect();
      socketRef.current = null;
      setUser(null);
      setView("home");
      setDonations([]);
      setRiderTasks([]);
      setAvailableTasks([]);
      setNotifications([]);
      navigate("home");
      toast("Logged out.");
    } catch (error) {
      toast(`Could not log out: ${error.message}`);
    }
  }

  async function runAction(operation, successMessage, refreshUser = user) {
    try {
      await operation();
      if (refreshUser) await refreshDashboardData(refreshUser);
      toast(successMessage);
    } catch (error) {
      if (error.status === 403 && error.code === "FORBIDDEN" && refreshUser) {
        try {
          const sessionUser = await syncSession();
          if (sessionUser?.id !== refreshUser.id || sessionUser?.role !== refreshUser.role) {
            toast(sessionUser
              ? `Your session changed to ${sessionUser.role} in another tab. Sign in as an NGO to accept donations.`
              : "Your session ended in another tab. Please sign in again.");
            return;
          }
        } catch (syncError) {
          toast(`Could not verify your session after the request failed: ${syncError.message}`);
          return;
        }
      }
      toast(error.message);
    }
  }

  async function createDonation(event) {
    event.preventDefault();
    if (user?.role !== "Donor") {
      openAuth("Donor");
      toast("Login as Donor to continue.");
      return;
    }
    try {
      let image = "";
      if (donationForm.image) {
        if (!donationForm.image.type.startsWith("image/") || donationForm.image.size > 600000) {
          throw new Error("Choose an image smaller than 600 KB.");
        }
        image = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("The selected image could not be read."));
          reader.readAsDataURL(donationForm.image);
        });
      }
      const body = {
        foodName: donationForm.foodName.trim(),
        quantity: Number(donationForm.quantity),
        category: donationForm.category,
        location: donationForm.location,
        address: donationForm.address.trim(),
        pickupBefore: donationForm.pickupBefore,
        expiryTime: new Date(donationForm.expiryTime).toISOString(),
        instructions: donationForm.instructions.trim(),
        image
      };
      if (donationForm.latitude || donationForm.longitude) {
        body.coordinates = { lat: Number(donationForm.latitude), lng: Number(donationForm.longitude) };
      }
      await apiRequest("/api/v1/donations", { method: "POST", body: JSON.stringify(body) });
      await refreshDashboardData();
      setDonationForm({
        foodName: "", quantity: "", category: "Prepared Meals", location: "Amritsar",
        address: "", pickupBefore: new Date(Date.now() + 3 * 3600000).toTimeString().slice(0, 5),
        expiryTime: localDateTime(5), latitude: "", longitude: "", instructions: "", image: null
      });
      event.currentTarget.reset();
      toast("Donation submitted for Admin approval.");
    } catch (error) {
      toast(error.message);
    }
  }

  const claimDonation = (donation) => {
    if (user?.role !== "NGO") return openAuth("NGO");
    if (!user.verified) return toast("Admin approval is required before claiming donations.");
    return runAction(() => apiRequest(`/api/v1/donations/${donation.id}/claim`, {
      method: "POST", body: JSON.stringify({ destinationAddress: user.address })
    }), "Donation reserved and delivery task created.");
  };

  const completeDonation = async (donation) => {
    const code = document.querySelector(`[data-code-for="${donation.id}"]`)?.value.trim();
    if (code !== donation.qrCode) return toast("Pickup code did not match.");
    return runAction(() => apiRequest(`/api/v1/donations/${donation.id}/complete`, {
      method: "POST", body: JSON.stringify({ qrCode: code })
    }), "Food collection verified.");
  };

  const updateAvailability = (available) => runAction(() => apiRequest("/api/v1/riders/me/availability", {
    method: "PATCH", body: JSON.stringify({ available })
  }).then((result) => setUser((current) => ({ ...current, available: result.available }))),
  available ? "You are available for delivery tasks." : "You are not accepting new tasks.", null);

  const riderAction = (id, action, success) => runAction(
    () => apiRequest(`/api/v1/assignments/${id}/${action}`, { method: action === "accept" ? "POST" : "PATCH" }),
    success
  );

  const clearNotifications = () => runAction(
    () => apiRequest("/api/v1/notifications", { method: "DELETE" }).then(() => setNotifications([])),
    "Notifications cleared.",
    null
  );

  const visibleDonorDonations = useMemo(() => donations
    .filter((item) => item.status !== "Removed")
    .filter((item) => donorFilter === "All"
      || (donorFilter === "Pending Approval" ? item.approvalStatus === "PENDING" : item.status === donorFilter)),
  [donations, donorFilter]);

  const visibleNgoDonations = useMemo(() => donations
    .filter((item) => item.status !== "Removed")
    .filter((item) => ngoCity === "All" || item.location === ngoCity)
    .sort((a, b) => freshness(a).label === freshness(b).label ? 0 : freshness(a).label === "Urgent" ? -1 : 1), [donations, ngoCity]);

  const nearestMatch = useMemo(() => {
    const available = donations.filter((item) => item.status === "Available");
    if (!available.length || !verifiedNgos.length) return null;
    const donation = [...available].sort((a, b) => new Date(a.expiryTime) - new Date(b.expiryTime))[0];
    const nearest = verifiedNgos.map((ngo) => ({
      ngo,
      distance: distanceKm(coordinatesOrCity(donation.coordinates, donation.location), coordinatesOrCity(ngo.coordinates, ngo.city))
    })).filter((item) => item.distance !== null).sort((a, b) => a.distance - b.distance)[0];
    return nearest ? { ...nearest, donation } : null;
  }, [donations, verifiedNgos]);

  const completedTasks = riderTasks.filter((task) => task.deliveryStatus === "COMPLETED");
  const historyTasks = riderTasks.filter((task) => !historySearch || [
      task.foodName, task.donor?.name, task.ngo?.name, task.quantity
    ].some((value) => String(value || "").toLowerCase().includes(historySearch.toLowerCase())));
  const activeTasks = riderTasks.filter((task) => ["ACCEPTED", "PICKED_UP", "DELIVERED"].includes(task.deliveryStatus));
  const totalMeals = completedTasks.reduce((sum, task) => sum + Number(task.quantity), 0);

  const mapPoints = useMemo(() => [
    ...donations.filter((item) => item.status === "Available").map((item) => ({
      type: "donation", title: item.foodName, subtitle: `${item.quantity} portions · ${item.location}`,
      donation: item,
      ...(coordinatesOrCity(item.coordinates, item.location) || {})
    })),
    ...(user?.role === "Rider" ? availableTasks.map((task) => ({
      type: "donation",
      title: task.foodName,
      subtitle: `${task.quantity} portions · ${task.location}`,
      donation: task,
      ...(coordinatesOrCity(task.coordinates, task.location) || {})
    })) : []),
    ...verifiedNgos.map((ngo) => ({
      type: "ngo", title: ngo.name, subtitle: ngo.city,
      ngo,
      ...(coordinatesOrCity(ngo.coordinates, ngo.city) || {})
    }))
  ].filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng)), [donations, verifiedNgos, availableTasks, user]);

  const todayStats = metrics || {};

  return (
    <>
      <header className="site-header" id="top">
        <nav className="navbar" aria-label="Primary navigation">
          <a className="brand" href="#home" onClick={(event) => { event.preventDefault(); navigate("home"); }}>
            <span><img src={foodBridgeLogo} alt="FoodBridge logo" width="70" /></span>
            <span><strong>FoodBridge</strong><small>Donation Network</small></span>
          </a>
          <button className="nav-toggle icon-button" type="button" aria-label="Toggle menu"
            aria-expanded={mobileMenuOpen} onClick={() => setMobileMenuOpen((open) => !open)}>
            <span /><span /><span />
          </button>
          <div className={`nav-links${mobileMenuOpen ? " open" : ""}`}>
            {navigation.map((item) => <a key={item} href={`#${item}`} className={view === item ? "active" : ""}
              onClick={(event) => { event.preventDefault(); navigate(item); }}>
              {item === "ngo" ? "NGO" : item[0].toUpperCase() + item.slice(1)}
            </a>)}
            <a href={adminAppUrl}>Admin</a>
          </div>
          <div className="nav-actions">
            <span className="user-chip">{user ? `${user.name} | ${user.role}` : "Guest"}</span>
            {user
              ? <button className="button ghost" type="button" onClick={logout}>Logout</button>
              : <button className="button primary" type="button" onClick={() => openAuth()}>Login</button>}
          </div>
        </nav>
      </header>

      <main>
        <section className={`view${view === "home" ? " active" : ""}`}>
          <div className="hero"><div className="hero-media" role="img" aria-label="Volunteers sorting donated food" />
            <div className="hero-overlay" /><div className="hero-content">
              <p className="eyebrow">Surplus food coordination platform</p><h1>FoodBridge</h1>
              <p className="hero-copy">Connect restaurants, marriage halls, hotels, cafeterias, and events with verified NGOs before fresh food becomes waste.</p>
              <div className="hero-actions">
                <button className="button primary large" onClick={() => openAuth("Donor")}>Create Donation</button>
                <button className="button light large" onClick={() => openAuth("NGO")}>Find Food Nearby</button>
              </div>
            </div>
          </div>
          <section className="impact-strip" aria-label="Network impact">
            <article><span>{(todayStats.mealsDelivered || 0).toLocaleString("en-IN")}</span><p>Meals Saved</p></article>
            <article><span>{((todayStats.foodRescuedKg || 0) / 1000).toFixed(1)} Tons</span><p>Food Rescued</p></article>
            <article><span>{todayStats.availableDonations || 0}</span><p>Live Donations</p></article>
            <article><span>{todayStats.verifiedNgos || 0}</span><p>Verified NGOs</p></article>
          </section>
          <section className="section-grid">
            <div className="section-intro"><p className="eyebrow">How the network moves</p>
              <h2>From extra meals to completed pickup</h2>
              <p>Every donation moves through a traceable status flow with freshness scoring, nearby NGO matching, pickup verification, and admin oversight.</p>
            </div>
            <div className="workflow">{["Create|Donors add food details, pickup timing, and location.",
              "Notify|Nearby verified NGOs see donations instantly.",
              "Reserve|An NGO claims the request and a rider task is created.",
              "Verify|The rider delivers and the NGO confirms receipt."].map((step, index) => {
                const [title, body] = step.split("|");
                return <article className="workflow-step" key={title}><span>0{index + 1}</span><h3>{title}</h3><p>{body}</p></article>;
              })}</div>
          </section>
        </section>

        <section className={`view${view === "donor" ? " active" : ""}`}>
          <div className="page-shell">
            <PageHeading eyebrow="Donor dashboard" title="List surplus food for safe pickup"
              action={user?.role !== "Donor" && <button className="button primary" onClick={() => openAuth("Donor")}>Donor Login</button>} />
            <div className="dashboard-grid">
              <aside className="panel stack">
                <div className="mini-stats">
                  <Stat label="Total" value={donations.length} />
                  <Stat label="Completed" value={donations.filter((item) => item.status === "Completed").length} />
                  <Stat label="Pending" value={donations.filter((item) => item.status !== "Completed").length} />
                  <Stat label="Meals saved" value={donations.filter((item) => item.status === "Completed").reduce((n, item) => n + item.quantity, 0)} />
                </div>
                <form className="form" onSubmit={createDonation}>
                  <div className="form-row two">
                    <Field label="Food Name"><input required value={donationForm.foodName} onChange={(e) => setDonationForm({ ...donationForm, foodName: e.target.value })} /></Field>
                    <Field label="Quantity"><input type="number" min="1" step="1" required value={donationForm.quantity} onChange={(e) => setDonationForm({ ...donationForm, quantity: e.target.value })} /></Field>
                  </div>
                  <div className="form-row two">
                    <Field label="Food Type"><select value={donationForm.category} onChange={(e) => setDonationForm({ ...donationForm, category: e.target.value })}>
                      {["Prepared Meals", "Bakery", "Groceries", "Fruits and Vegetables"].map((item) => <option key={item}>{item}</option>)}
                    </select></Field>
                    <Field label="Pickup Before"><input type="time" required value={donationForm.pickupBefore} onChange={(e) => setDonationForm({ ...donationForm, pickupBefore: e.target.value })} /></Field>
                  </div>
                  <Field label="Expiry Time"><input type="datetime-local" required value={donationForm.expiryTime} onChange={(e) => setDonationForm({ ...donationForm, expiryTime: e.target.value })} /></Field>
                  <div className="form-row two">
                    <Field label="City"><select value={donationForm.location} onChange={(e) => setDonationForm({ ...donationForm, location: e.target.value })}>
                      {Object.keys(cities).map((city) => <option key={city}>{city}</option>)}
                    </select></Field>
                    <Field label="Food Image"><input type="file" accept="image/*" onChange={(e) => setDonationForm({ ...donationForm, image: e.target.files?.[0] || null })} /></Field>
                  </div>
                  <Field label="Pickup Address"><textarea required rows="3" value={donationForm.address} onChange={(e) => setDonationForm({ ...donationForm, address: e.target.value })} /></Field>
                  <div className="form-row two">
                    <Field label="Pickup latitude (optional)"><input type="number" min="-90" max="90" step="any" value={donationForm.latitude} onChange={(e) => setDonationForm({ ...donationForm, latitude: e.target.value })} /></Field>
                    <Field label="Pickup longitude (optional)"><input type="number" min="-180" max="180" step="any" value={donationForm.longitude} onChange={(e) => setDonationForm({ ...donationForm, longitude: e.target.value })} /></Field>
                  </div>
                  <Field label="Special handling and storage instructions"><textarea rows="2" maxLength="500" value={donationForm.instructions} onChange={(e) => setDonationForm({ ...donationForm, instructions: e.target.value })} /></Field>
                  <button className="button primary full" type="submit">Create Donation</button>
                </form>
              </aside>
              <section className="panel">
                <div className="panel-heading"><div><p className="eyebrow">Donation history</p><h3>Your food rescue board</h3></div>
                  <select value={donorFilter} onChange={(e) => setDonorFilter(e.target.value)} aria-label="Filter donor donations">
                    {["All", "Pending Approval", "Available", "Reserved", "Completed"].map((item) => <option key={item}>{item}</option>)}
                  </select>
                </div>
                <div className="donation-list">{user?.role === "Donor" && visibleDonorDonations.length
                  ? visibleDonorDonations.map((item) => <DonationCard key={item.id} donation={item} mode="donor" />)
                  : <EmptyState>{user?.role === "Donor" ? "No donations match this filter." : "Sign in as a donor to see your donations."}</EmptyState>}</div>
              </section>
            </div>
          </div>
        </section>

        <section className={`view${view === "ngo" ? " active" : ""}`}>
          <div className="page-shell">
            <PageHeading eyebrow="NGO dashboard" title="Claim nearby donations and close pickups"
              action={user?.role !== "NGO" && <button className="button primary" onClick={() => openAuth("NGO")}>NGO Login</button>} />
            <div className="dashboard-grid ngo-layout">
              <aside className="panel stack">
                <div className="mini-stats">
                  <Stat label="Collected" value={donations.filter((item) => item.claimedBy === user?.id && item.status === "Completed").length} />
                  <Stat label="Pending" value={donations.filter((item) => item.claimedBy === user?.id && item.status === "Reserved").length} />
                  <Stat label="Nearby" value={visibleNgoDonations.filter((item) => item.status === "Available").length} />
                  <Stat label="Meals" value={donations.filter((item) => item.claimedBy === user?.id && item.status === "Completed").reduce((n, item) => n + item.quantity, 0)} />
                </div>
                <div className="matcher-box"><p className="eyebrow">Matching</p>
                  <h3>{nearestMatch?.ngo.name || "Nearest NGO"}</h3>
                  <p>{nearestMatch ? `${nearestMatch.distance.toFixed(1)} KM from ${nearestMatch.donation.foodName} in ${nearestMatch.donation.location}.` : "No active match available right now."}</p>
                </div>
                <div className="notifications"><div className="panel-heading compact"><h3>Notifications</h3>
                  <button className="icon-button subtle" onClick={clearNotifications} aria-label="Clear notifications">X</button></div>
                  <NotificationList notifications={notifications} /></div>
              </aside>
              <section className="panel">
                <div className="panel-heading"><div><p className="eyebrow">Nearby donations</p><h3>Available for pickup</h3></div>
                  <select value={ngoCity} onChange={(e) => setNgoCity(e.target.value)} aria-label="Filter by city">
                    <option>All</option>{Object.keys(cities).map((city) => <option key={city}>{city}</option>)}
                  </select>
                </div>
                <div className="donation-list cards">{user?.role === "NGO" && visibleNgoDonations.length
                  ? visibleNgoDonations.map((item) => <DonationCard key={item.id} donation={item} mode="ngo"
                    user={user} onClaim={claimDonation} onComplete={completeDonation}
                    onReceipt={(id) => runAction(() => apiRequest(`/api/v1/assignments/${id}/receipt`, { method: "PATCH" }), "Receipt confirmed. Delivery completed.")} />)
                  : <EmptyState>{user?.role === "NGO" ? "No donations are visible for this city." : "Sign in as an NGO to view nearby donations."}</EmptyState>}</div>
              </section>
            </div>
          </div>
        </section>

        <section className={`view${view === "rider" ? " active" : ""}`}>
          {user?.role === "Rider" ? <div className="page-shell rider-shell">
            <aside className="rider-sidebar panel">
              <div className="rider-profile"><div className="rider-avatar">{user.name?.[0]?.toUpperCase() || "R"}</div>
                <div><strong>{user.name}</strong><span>{user.city || "FoodBridge Rider"}</span></div></div>
              <label className="availability-toggle"><span>Available for tasks</span>
                <input type="checkbox" checked={Boolean(user.available)} onChange={(e) => updateAvailability(e.target.checked)} /></label>
              <nav className="rider-menu" aria-label="Rider dashboard navigation">
                {riderSections.map((section) => <button key={section} type="button"
                  className={riderSection === section ? "active" : ""}
                  onClick={() => setRiderSection(section)}>
                  {section === "active" ? "My Deliveries"
                    : section === "history" ? `Delivery History (${riderTasks.length})`
                      : section === "notifications" ? `Notifications (${notifications.length})`
                        : section[0].toUpperCase() + section.slice(1)}
                </button>)}
                <button type="button" onClick={logout}>Log out</button>
              </nav>
            </aside>
            <div className="rider-content">
              {riderSection === "overview" && <>
                <PageHeading eyebrow="Delivery partner" title="Rider dashboard" />
                <p className="rider-welcome">Welcome, {user.name}. Here is your delivery overview.</p>
                <div className="rider-stat-grid">
                  <RiderStat label="Available Tasks" value={availableTasks.length} />
                  <RiderStat label="Active Deliveries" value={activeTasks.length} />
                  <RiderStat label="Completed Deliveries" value={completedTasks.length} />
                  <RiderStat label="Total Meals Delivered" value={totalMeals} />
                </div>
                <section className="panel rider-task-panel"><div className="panel-heading"><div><p className="eyebrow">Ready to rescue</p><h3>Available delivery tasks</h3></div>
                  <button className="button secondary" onClick={() => setRiderSection("available")}>View all</button></div>
                  <TaskList tasks={availableTasks.slice(0, 3)} mode="available" available={user.available}
                    onAction={(id) => riderAction(id, "accept", "Delivery assigned to you.")} empty="There are no available delivery tasks." /></section>
                <section className="panel rider-task-panel"><div className="panel-heading"><div><p className="eyebrow">Recent updates</p><h3>Notifications</h3></div>
                  <button className="button secondary" onClick={() => setRiderSection("notifications")}>View all</button></div>
                  <NotificationList notifications={notifications.slice(0, 3)} /></section>
              </>}
              {riderSection === "available" && <><PageHeading eyebrow="New opportunities" title="Available tasks" />
                <TaskList tasks={availableTasks} mode="available" available={user.available}
                  onAction={(id) => riderAction(id, "accept", "Delivery assigned to you.")} empty="There are no available delivery tasks." /></>}
              {riderSection === "active" && <><PageHeading eyebrow="Your route" title="My active deliveries" />
                <TaskList tasks={activeTasks} mode="active" onAction={(id, action) => riderAction(id, action,
                  action === "pickup" ? "Pickup confirmed. Donor and NGO have been notified." : "Marked as delivered. The NGO must confirm receipt.")} empty="You have no active deliveries." /></>}
              {riderSection === "history" && <><PageHeading eyebrow="Delivery history" title="All my deliveries" />
                <label className="rider-search">Search deliveries<input type="search" value={historySearch} onChange={(e) => setHistorySearch(e.target.value)} placeholder="Search food, donor, or NGO" /></label>
                <TaskList tasks={historyTasks} mode="history" empty="Deliveries you accept will appear here." /></>}
              {riderSection === "notifications" && <><PageHeading eyebrow="Updates" title="Notifications" />
                <div className="notifications"><NotificationList notifications={notifications} /></div></>}
            </div>
          </div> : <div className="page-shell"><section className="panel"><EmptyState>Sign in as a delivery partner to access rider tasks.</EmptyState>
            <button className="button primary" onClick={() => openAuth("Rider")}>Rider Login</button></section></div>}
        </section>

        <section className={`view${view === "map" ? " active" : ""}`}>
          <div className="page-shell"><PageHeading eyebrow="FoodBridge locations" title="Live rescue map"
            action={<button className="button secondary" onClick={() => setMapFitRequest((request) => request + 1)}>Fit Markers</button>} />
            <div className="map-grid"><section className="panel map-panel">
              <MapContainer center={[30.9, 75.85]} zoom={7} scrollWheelZoom className="foodbridge-map"
                aria-label="Map of active food donations and verified NGOs">
                <TileLayer
                  attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors'
                  url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <MapViewport points={mapPoints} fitRequest={mapFitRequest} />
                {mapPoints.map((point, index) => <CircleMarker key={`${point.type}-${point.title}-${index}`}
                  center={[point.lat, point.lng]} radius={9}
                  pathOptions={{
                    color: "#ffffff",
                    weight: 3,
                    fillColor: point.type === "ngo" ? "#0f8b6d" : "#e86f51",
                    fillOpacity: 1
                  }}>
                  <Popup>
                    <strong>{point.title}</strong><br />
                    {point.subtitle}
                    {point.donation && <>
                      <br />Category: {point.donation.category}
                      <br />Pickup by: {point.donation.pickupBefore}
                      <br />{point.donation.address}
                    </>}
                    {point.ngo && point.ngo.address && <><br />{point.ngo.address}</>}
                  </Popup>
                </CircleMarker>)}
              </MapContainer>
              {!user && <div className="map-auth-prompt">
                <p>Sign in to see current donation and verified NGO locations.</p>
                <button className="button primary" onClick={() => openAuth("Donor")}>Login to view map</button>
              </div>}
            </section>
              <aside className="panel stack"><div className="panel-heading compact"><h3>Map Points</h3></div>
                <div className="map-legend">{mapPoints.map((point, index) => <div className="legend-item" key={`${point.type}-${index}`}>
                  <span className={`legend-dot ${point.type}`} /><div><strong>{point.title}</strong><br />{point.subtitle}</div></div>)}
                  {!mapPoints.length && <EmptyState>Sign in to see current donation and NGO locations.</EmptyState>}</div>
                <div className="matcher-box"><p className="eyebrow">Pickup intelligence</p><h3>Freshness first</h3>
                  <p>Urgent donations appear first, then nearest verified NGOs.</p></div>
              </aside>
            </div>
          </div>
        </section>
      </main>

      {authOpen && <div className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="authTitle">
        <button className="modal-backdrop" aria-label="Close dialog" onClick={() => setAuthOpen(false)} />
        <section className="modal-card"><button className="icon-button close" onClick={() => setAuthOpen(false)} aria-label="Close login">X</button>
          <div className="auth-tabs" role="tablist" aria-label="Authentication mode">
            {["login", "register"].map((mode) => <button key={mode} className={authMode === mode ? "active" : ""}
              onClick={() => {
                setAuthMode(mode);
                if (mode === "register" && authRole === "Admin") setAuthRole("Donor");
              }} type="button">{mode[0].toUpperCase() + mode.slice(1)}</button>)}
          </div>
          <h2 id="authTitle">{authMode === "login" ? "Login" : "Register"}</h2>
          <form className="form" onSubmit={submitAuth}>
            {authMode === "register" && <Field label="Name"><input name="name" required maxLength="100" /></Field>}
            <Field label="Email"><input name="email" type="email" required autoComplete="email" /></Field>
            <Field label="Password"><input name="password" type="password" minLength="10" maxLength="200" required autoComplete={authMode === "login" ? "current-password" : "new-password"} /></Field>
            <Field label="Role"><select name="role" value={authRole} onChange={(e) => setAuthRole(e.target.value)}>
              {["Donor", "NGO", "Admin", "Rider"].map((role) => <option key={role} disabled={authMode === "register" && role === "Admin"}>{role}</option>)}
            </select></Field>
            {authMode === "login" && authRole === "Admin" && <div className="admin-login-prompt" role="note">
              <span>Admin accounts must be created separately. Use the provisioned Admin email and password; selecting Admin does not change another account's role.</span>
              <span>For setup, set ADMIN_EMAIL and ADMIN_PASSWORD, then run <code>npm run create-admin</code>. Use an email not already registered with another role.</span>
            </div>}
            {authMode === "register" && <>
              <Field label="City"><input name="city" maxLength="80" required={authRole === "NGO"} /></Field>
              <Field label="Organization / pickup address"><input name="address" maxLength="240" required={authRole === "NGO"} /></Field>
              <Field label="Contact phone"><input name="phone" type="tel" maxLength="32" required={authRole === "NGO"} /></Field>
              <div className="form-row two">
                <Field label="Latitude (optional)"><input name="latitude" type="number" step="any" min="-90" max="90" /></Field>
                <Field label="Longitude (optional)"><input name="longitude" type="number" step="any" min="-180" max="180" /></Field>
              </div>
            </>}
            <button className="button primary full" type="submit" disabled={authBusy}>{authBusy ? "Please wait..." : authMode === "login" ? "Login" : "Create Account"}</button>
          </form>
          {authMode === "register" && <div className="admin-login-prompt">
            <span>Admin accounts can't be registered here.</span>
            <button type="button" className="button ghost" onClick={() => {
              setAuthMode("login");
              setAuthRole("Admin");
            }}>Go to Admin Login</button>
          </div>}
          <p className="auth-note">Accounts and delivery data are stored securely by the FoodBridge server.</p>
        </section>
      </div>}
      <div className="toast-region" aria-live="polite">{toastMessages.map((item) => <div className="toast" key={item.id}>{item.message}</div>)}</div>
      {loading && <div className="loading-indicator" role="status">Connecting to FoodBridge…</div>}
    </>
  );
}

function PageHeading({ eyebrow, title, action }) {
  return <div className="page-heading"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>{action}</div>;
}

function Field({ label, children }) {
  return <label>{label}{children}</label>;
}

function RiderStat({ label, value }) {
  return <article className="rider-stat"><span>{label}</span><strong>{value}</strong></article>;
}

function NotificationList({ notifications }) {
  return notifications.length
    ? notifications.map((item) => <div className="notification-item" key={item.id}>{item.text}</div>)
    : <EmptyState>No new notifications.</EmptyState>;
}

function DonationCard({ donation, mode, user, onClaim, onComplete, onReceipt }) {
  const freshnessInfo = freshness(donation);
  const claimingNgo = mode === "ngo" && user?.id === donation.claimedBy;
  const showQr = claimingNgo && donation.status === "Reserved" && !donation.riderId;
  const awaitingReceipt = claimingNgo && donation.deliveryStatus === "DELIVERED";
  const inDelivery = claimingNgo && donation.deliveryStatus
    && !["DELIVERED", "COMPLETED"].includes(donation.deliveryStatus);
  const destination = coordinatesOrCity(donation.ngo?.coordinates, donation.ngo?.city);
  const distance = distanceKm(coordinatesOrCity(donation.coordinates, donation.location), destination);
  return <article className="donation-card">
    <div className="donation-image" style={{ backgroundImage: donation.image ? `url("${donation.image}")` : undefined }} />
    <div><div className="donation-topline"><h4>{donation.foodName}</h4><span className={`pill ${donation.approvalStatus === "PENDING" ? "reserved" : statusClass(donation.status)}`}>
      {donation.approvalStatus === "PENDING" ? "Pending Admin Approval" : donation.status}</span></div>
      <p>{donation.quantity} portions from {donation.donor?.name || "Unknown donor"} at {donation.address}.</p>
      <div className="meta-row"><span className="pill">{donation.category}</span><span className="pill">{donation.location}</span>
        <span className={`pill ${freshnessInfo.className}`}>{freshnessInfo.label}</span><span className="pill">Pickup {donation.pickupBefore}</span>
        {distance !== null && <span className="pill">{distance.toFixed(1)} KM to NGO</span>}
        {donation.ngo?.name && <span className="pill">Claimed by {donation.ngo.name}</span>}</div>
      {showQr && <div className="qr-box"><div className="qr-placeholder" aria-hidden="true">QR</div><div>
        <strong>{donation.qrCode}</strong><small>Pickup verification code</small>
        <input data-code-for={donation.id} placeholder="Enter pickup code" aria-label={`Pickup code for ${donation.foodName}`} />
      </div></div>}
      <div className="card-actions">
        {mode === "ngo" && donation.status === "Available" && <button className="button primary" onClick={() => onClaim(donation)}>Accept Donation</button>}
        {showQr && <button className="button secondary" onClick={() => onComplete(donation)}>Verify Pickup</button>}
        {awaitingReceipt && <button className="button primary" onClick={() => onReceipt(donation.id)}>Confirm Receipt</button>}
        {inDelivery && <span className="pill reserved">Rider status: {donation.deliveryStatus.replaceAll("_", " ")}</span>}
      </div>
    </div>
  </article>;
}

function TaskList({ tasks, mode, available, onAction, empty }) {
  if (!tasks.length) return <div className="rider-task-list"><EmptyState>{empty}</EmptyState></div>;
  return <div className="rider-task-list">{tasks.map((task) => {
    const pickupCoordinates = coordinatesOrCity(task.coordinates, task.location);
    const destinationCoordinates = coordinatesOrCity(task.destinationCoordinates, task.ngo?.city);
    const distance = distanceKm(pickupCoordinates, destinationCoordinates);
    let action = null;
    if (mode === "available") action = <button className="button primary" disabled={!available}
      onClick={() => onAction(task.id)}>Accept Delivery</button>;
    else if (mode === "active" && task.deliveryStatus === "ACCEPTED") action = <button className="button primary" onClick={() => onAction(task.id, "pickup")}>Confirm Pickup</button>;
    else if (mode === "active" && task.deliveryStatus === "PICKED_UP") action = <button className="button secondary" onClick={() => onAction(task.id, "deliver")}>Mark as Delivered</button>;
    else if (mode === "active" && task.deliveryStatus === "DELIVERED") action = <span className="pill reserved">Waiting for NGO receipt confirmation</span>;
    return <article className="rider-task-card" key={task.id}>
      <div className="rider-task-heading"><div><p className="eyebrow">{task.category}</p><h3>{task.foodName}</h3></div>
        <span className={`pill ${statusClass(task.deliveryStatus || "AVAILABLE")}`}>{(task.deliveryStatus || "AVAILABLE").replaceAll("_", " ")}</span>
      </div>
      <div className="rider-task-details">
        <div><strong>Food quantity</strong>{task.quantity} portions</div>
        <div><strong>Donor / restaurant</strong>{task.donor?.name || "Food donor"}{task.donor?.phone && <><br /><a href={`tel:${task.donor.phone}`}>{task.donor.phone}</a></>}</div>
        <div><strong>Pickup location</strong>{task.address} · {task.location}</div>
        <div><strong>NGO delivery location</strong>{task.destinationAddress || task.ngo?.address || task.ngo?.city || "Destination unavailable"}
          {task.ngo?.phone && <><br /><a href={`tel:${task.ngo.phone}`}>{task.ngo.phone}</a></>}</div>
        <div><strong>Distance</strong>{distance === null ? "Not available" : `${distance.toFixed(1)} km${isValidCoordinates(task.coordinates) && isValidCoordinates(task.destinationCoordinates) ? "" : " (approx.)"}`}</div>
        <div><strong>Pickup deadline</strong>{task.pickupBefore} · {new Date(task.expiryTime).toLocaleString()}</div>
        <div><strong>Special handling</strong>{task.instructions || "No special instructions"}</div>
        {(mode === "completed" || mode === "history") && <div><strong>{mode === "completed" ? "Delivery date" : "Last activity"}</strong>
          {new Date(task.completedAt || task.deliveredAt || task.pickedUpAt || task.acceptedAt || task.createdAt).toLocaleString()}</div>}
      </div>
      {action && <div className="card-actions">{action}</div>}
    </article>;
  })}</div>;
}

export default App;
