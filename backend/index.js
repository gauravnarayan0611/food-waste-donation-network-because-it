const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const backendEnv = path.join(__dirname, ".env");
const projectEnv = path.join(__dirname, "..", ".env");
require("dotenv").config({ path: fs.existsSync(backendEnv) ? backendEnv : projectEnv });
const express = require("express");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const Donation = require("./models/Donation");
const User = require("./models/User");

const scrypt = promisify(crypto.scrypt);
const app = express();
const httpServer = require("node:http").createServer(app);
const localDevelopmentOrigins = [
  "http://localhost:5174",
  "http://127.0.0.1:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5175",
  "http://localhost:5500",
  "http://127.0.0.1:5500"
];
const allowedOrigins = [...new Set([
  ...localDevelopmentOrigins,
  ...String(process.env.FRONTEND_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean)
])];
const io = new Server(httpServer, {
  cors: { origin: allowedOrigins, credentials: true }
});
const cookieName = "foodbridge_session";
const tokenLifetimeSeconds = 60 * 60 * 24 * 7;
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.vary("Origin");
    if (req.method === "OPTIONS") return res.sendStatus(204);
  }
  return next();
});
function sendSuccess(res, data, status = 200) {
  res.status(status).json({ success: true, data });
}

function sendError(res, status, code, message) {
  res.status(status).json({ success: false, error: { code, message } });
}

function signToken(userId, role) {
  const secret = process.env.FOODBRIDGE_JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("FOODBRIDGE_JWT_SECRET must be set to at least 32 characters.");
  }
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    sub: String(userId),
    role,
    exp: Math.floor(Date.now() / 1000) + tokenLifetimeSeconds
  })).toString("base64url");
  const body = `${header}.${payload}`;
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verifyToken(token) {
  const secret = process.env.FOODBRIDGE_JWT_SECRET;
  if (!secret || secret.length < 32) throw new Error("Authentication is not configured.");
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  const body = `${parts[0]}.${parts[1]}`;
  const expected = crypto.createHmac("sha256", secret).update(body).digest();
  let actual;
  try {
    actual = Buffer.from(parts[2], "base64url");
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!payload.sub || !payload.role || payload.exp <= Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function cookieOptions() {
  const sameSite = process.env.FOODBRIDGE_COOKIE_SAME_SITE || "lax";
  return {
    httpOnly: true,
    sameSite,
    secure: process.env.NODE_ENV === "production" || sameSite === "none",
    path: "/",
    maxAge: tokenLifetimeSeconds * 1000
  };
}

function getCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");
  const entry = cookies.find((item) => item.trim().startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.trim().slice(name.length + 1)) : "";
}

async function authenticate(req, res, next) {
  try {
    const claims = verifyToken(getCookie(req, cookieName));
    if (!claims) return sendError(res, 401, "UNAUTHENTICATED", "Please sign in to continue.");
    const user = await User.findById(claims.sub);
    if (!user || user.role !== claims.role) {
      return sendError(res, 401, "UNAUTHENTICATED", "Your session is no longer valid.");
    }
    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      const requiredRole = roles.length === 1 ? roles[0] : "an authorized account";
      return sendError(res, 403, "FORBIDDEN", `${requiredRole} access is required. You are signed in as ${req.user.role}.`);
    }
    return next();
  };
}

function validCoordinates(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const missing = (coordinate) => coordinate === undefined || coordinate === null || coordinate === "";
  const latMissing = missing(value.lat);
  const lngMissing = missing(value.lng);
  if (latMissing && lngMissing) return null;
  if (latMissing || lngMissing) return false;
  const lat = Number(value.lat);
  const lng = Number(value.lng);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lng) || lng < -180 || lng > 180) {
    return false;
  }
  return { lat, lng };
}

function publicUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    city: user.city,
    address: user.address,
    phone: user.phone,
    coordinates: validCoordinates(user.coordinates) || undefined,
    verified: user.verified,
    available: user.available
  };
}

function serializeDonation(donation, viewer) {
  const assignedRider = donation.rider && String(donation.rider._id || donation.rider) === String(viewer._id);
  const relatedDonor = String(donation.donor._id || donation.donor) === String(viewer._id);
  const relatedNgo = donation.claimedBy && String(donation.claimedBy._id || donation.claimedBy) === String(viewer._id);
  const canSeeContacts = assignedRider || relatedDonor || relatedNgo || viewer.role === "Admin";
  const donor = donation.donor && donation.donor.name ? {
    id: String(donation.donor._id),
    name: donation.donor.name,
    ...(canSeeContacts ? { phone: donation.donor.phone } : {})
  } : null;
  const ngo = donation.claimedBy && donation.claimedBy.name ? {
    id: String(donation.claimedBy._id),
    name: donation.claimedBy.name,
    city: donation.claimedBy.city,
    coordinates: donation.claimedBy.coordinates,
    ...(canSeeContacts ? { address: donation.claimedBy.address, phone: donation.claimedBy.phone } : {})
  } : null;
  const rider = donation.rider && donation.rider.name ? {
    id: String(donation.rider._id),
    name: donation.rider.name,
    ...(canSeeContacts ? { phone: donation.rider.phone } : {})
  } : null;

  return {
    id: String(donation._id),
    approvalStatus: donationApprovalStatus(donation),
    foodName: donation.foodName,
    quantity: donation.quantity,
    category: donation.category,
    donorId: String(donation.donor._id || donation.donor),
    donor,
    location: donation.location,
    address: donation.address,
    coordinates: validCoordinates(donation.coordinates) || undefined,
    destinationAddress: donation.destinationAddress,
    destinationCoordinates: validCoordinates(donation.destinationCoordinates) || undefined,
    pickupBefore: donation.pickupBefore,
    expiryTime: donation.expiryTime,
    image: donation.image,
    instructions: donation.instructions,
    status: donation.status,
    claimedBy: donation.claimedBy ? String(donation.claimedBy._id || donation.claimedBy) : null,
    ngo,
    deliveryStatus: donation.deliveryStatus,
    riderId: donation.rider ? String(donation.rider._id || donation.rider) : null,
    rider,
    acceptedAt: donation.acceptedAt,
    pickedUpAt: donation.pickedUpAt,
    deliveredAt: donation.deliveredAt,
    completedAt: donation.completedAt,
    qrCode: relatedNgo ? donation.qrCode : undefined,
    createdAt: donation.createdAt
  };
}

function donationApprovalStatus(donation) {
  return donation.status === "Reserved" && !donation.claimedBy && !donation.rider ? "PENDING" : "APPROVED";
}

function populatedDonations(query) {
  return query.populate("donor", "name phone city address")
    .populate("claimedBy", "name phone city address coordinates")
    .populate("rider", "name phone city");
}

async function notifyUsers(userIds, text, event, payload = {}) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (ids.length) {
    await User.updateMany(
      { _id: { $in: ids } },
      { $push: { notifications: { $each: [{ text, at: new Date() }], $slice: -20 } } }
    );
  }
  ids.forEach((id) => io.to(`user:${id}`).emit("notification", { text, ...payload }));
  if (event) io.emit(event, payload);
}

function validateDonation(body) {
  const required = ["foodName", "quantity", "category", "location", "address", "pickupBefore", "expiryTime"];
  if (required.some((key) => body[key] === undefined || String(body[key]).trim() === "")) return "Complete all required donation fields.";
  if (!Number.isInteger(Number(body.quantity)) || Number(body.quantity) < 1) return "Quantity must be a positive whole number.";
  if (!Number.isFinite(Date.parse(body.expiryTime)) || Date.parse(body.expiryTime) <= Date.now()) return "Expiry time must be in the future.";
  if (body.instructions && String(body.instructions).length > 500) return "Instructions must be 500 characters or fewer.";
  if (body.image && (typeof body.image !== "string" || body.image.length > 800000 || !body.image.startsWith("data:image/"))) {
    return "Food images must be image files smaller than 600 KB.";
  }
  for (const key of ["coordinates", "destinationCoordinates"]) {
    if (validCoordinates(body[key]) === false) return `Invalid ${key}.`;
  }
  return null;
}

app.get("/api/v1/health", (req, res) => sendSuccess(res, { status: "ok", database: mongoose.connection.readyState === 1 ? "connected" : "disconnected" }));

app.post("/api/v1/auth/register", async (req, res, next) => {
  try {
    const { name, email, password, role, city = "", address = "", phone = "" } = req.body || {};
    const normalizedEmail = String(email || "").trim().toLowerCase();
    if (!String(name || "").trim() || String(name).length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return sendError(res, 400, "INVALID_INPUT", "Enter a valid name and email address.");
    }
    if (typeof password !== "string" || password.length < 10 || password.length > 200) {
      return sendError(res, 400, "INVALID_INPUT", "Password must be between 10 and 200 characters.");
    }
    if (!["Donor", "NGO", "Rider"].includes(role)) {
      return sendError(res, 400, "INVALID_ROLE", "Choose Donor, NGO, or Rider. Admins must be provisioned by an administrator.");
    }
    if (role === "NGO" && (!String(city).trim() || !String(address).trim() || !String(phone).trim())) {
      return sendError(res, 400, "INVALID_INPUT", "NGO registration requires a city, delivery address, and contact phone.");
    }
    if ([city, address, phone].some((value) => typeof value !== "string") || String(city).length > 80 || String(address).length > 240 || String(phone).length > 32) {
      return sendError(res, 400, "INVALID_INPUT", "Profile fields exceed their allowed length.");
    }
    const coordinates = validCoordinates(req.body.coordinates);
    if (coordinates === false) return sendError(res, 400, "INVALID_INPUT", "Profile coordinates are invalid.");
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = await scrypt(password, salt, 64);
    const user = await User.create({
      name: String(name).trim(),
      email: normalizedEmail,
      passwordHash: `${salt}:${hash.toString("hex")}`,
      role,
      city: city.trim(),
      address: address.trim(),
      phone: phone.trim(),
      coordinates: coordinates || undefined,
      verified: role !== "NGO"
    });
    res.cookie(cookieName, signToken(user._id, user.role), cookieOptions());
    return sendSuccess(res, { user: publicUser(user) }, 201);
  } catch (error) {
    if (error.code === 11000) return sendError(res, 409, "EMAIL_EXISTS", "An account with this email already exists.");
    return next(error);
  }
});

app.post("/api/v1/auth/login", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = req.body?.password;
    const role = req.body?.role;
    const user = await User.findOne({ email }).select("+passwordHash");
    if (!user || typeof password !== "string" || !["Donor", "NGO", "Admin", "Rider"].includes(role) || user.role !== role) {
      return sendError(res, 401, "INVALID_CREDENTIALS", "Email, password, or account type was incorrect.");
    }
    const [salt, expectedHex] = user.passwordHash.split(":");
    const actual = await scrypt(password, salt, 64);
    const expected = Buffer.from(expectedHex, "hex");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
      return sendError(res, 401, "INVALID_CREDENTIALS", "Email, password, or account type was incorrect.");
    }
    res.cookie(cookieName, signToken(user._id, user.role), cookieOptions());
    return sendSuccess(res, { user: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/v1/auth/logout", (req, res) => {
  res.clearCookie(cookieName, { ...cookieOptions(), maxAge: undefined });
  return sendSuccess(res, { loggedOut: true });
});

app.get("/api/v1/auth/session", async (req, res, next) => {
  try {
    const claims = verifyToken(getCookie(req, cookieName));
    if (!claims) return sendSuccess(res, { user: null });
    const user = await User.findById(claims.sub);
    if (!user || user.role !== claims.role) return sendSuccess(res, { user: null });
    return sendSuccess(res, { user: publicUser(user) });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/notifications", authenticate, (req, res) => {
  const notifications = [...req.user.notifications].reverse().map((item) => ({
    id: String(item._id),
    text: item.text,
    at: item.at
  }));
  return sendSuccess(res, notifications);
});

app.delete("/api/v1/notifications", authenticate, async (req, res, next) => {
  try {
    req.user.notifications = [];
    await req.user.save();
    return sendSuccess(res, { cleared: true });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/donations", authenticate, async (req, res, next) => {
  try {
    let filter = {};
    if (req.user.role === "Donor") filter.donor = req.user._id;
    else if (req.user.role === "NGO") {
      filter.$or = [{ status: "Available", expiryTime: { $gt: new Date() } }, { claimedBy: req.user._id }];
    }
    else if (req.user.role === "Rider") filter.rider = req.user._id;
    const donations = await populatedDonations(Donation.find(filter).sort({ createdAt: -1 }));
    return sendSuccess(res, donations.map((item) => serializeDonation(item, req.user)));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/admin/ngos", authenticate, requireRole("Admin"), async (req, res, next) => {
  try {
    const ngos = await User.find({ role: "NGO" }).sort({ name: 1 });
    return sendSuccess(res, ngos.map(publicUser));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/ngos/verified", authenticate, async (req, res, next) => {
  try {
    const ngos = await User.find({ role: "NGO", verified: true }).select("name city coordinates").sort({ name: 1 });
    return sendSuccess(res, ngos.map((ngo) => ({
      id: String(ngo._id),
      name: ngo.name,
      city: ngo.city,
      coordinates: validCoordinates(ngo.coordinates) || undefined
    })));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/overview", authenticate, async (req, res, next) => {
  try {
    const [available, completed, verifiedNgos, users] = await Promise.all([
      Donation.countDocuments({ status: "Available" }),
      Donation.find({ status: "Completed" }).select("quantity"),
      User.countDocuments({ role: "NGO", verified: true }),
      req.user.role === "Admin" ? User.countDocuments() : Promise.resolve(undefined)
    ]);
    return sendSuccess(res, {
      availableDonations: available,
      completedDeliveries: completed.length,
      mealsDelivered: completed.reduce((sum, item) => sum + item.quantity, 0),
      foodRescuedKg: completed.reduce((sum, item) => sum + item.quantity * 0.45, 0),
      verifiedNgos,
      ...(users === undefined ? {} : { users })
    });
  } catch (error) {
    return next(error);
  }
});

app.post("/api/v1/donations", authenticate, requireRole("Donor"), async (req, res, next) => {
  try {
    const invalid = validateDonation(req.body || {});
    if (invalid) return sendError(res, 400, "INVALID_INPUT", invalid);
    const donation = await Donation.create({
      foodName: String(req.body.foodName).trim(),
      quantity: Number(req.body.quantity),
      category: String(req.body.category).trim(),
      donor: req.user._id,
      location: String(req.body.location).trim(),
      address: String(req.body.address).trim(),
      coordinates: validCoordinates(req.body.coordinates) || undefined,
      pickupBefore: String(req.body.pickupBefore).trim(),
      expiryTime: new Date(req.body.expiryTime),
      image: req.body.image || "",
      instructions: String(req.body.instructions || "").trim(),
      status: "Reserved",
      claimedBy: null,
      destinationAddress: "",
      destinationCoordinates: undefined,
      deliveryStatus: null,
      rider: null,
      qrCode: `FB-${crypto.randomBytes(3).toString("hex").toUpperCase()}`
    });
    const populated = await populatedDonations(Donation.findById(donation._id));
    const result = serializeDonation(populated, req.user);
    const admins = await User.find({ role: "Admin" }).select("_id");
    await notifyUsers(
      admins.map((admin) => admin._id),
      `${result.foodName} was submitted and is waiting for approval.`,
      "donation:submitted",
      { donationId: result.id }
    );
    return sendSuccess(res, result, 201);
  } catch (error) {
    return next(error);
  }
});

app.post("/api/v1/donations/:id/claim", authenticate, requireRole("NGO"), async (req, res, next) => {
  try {
    if (!req.user.verified) return sendError(res, 403, "NGO_NOT_VERIFIED", "Admin approval is required before claiming donations.");
    const destinationAddress = String(req.body?.destinationAddress || req.user.address || req.user.city || "").trim();
    if (!destinationAddress || destinationAddress.length > 240) return sendError(res, 400, "INVALID_INPUT", "Enter a valid NGO delivery address.");
    const coordinates = validCoordinates(req.body?.destinationCoordinates || req.user.coordinates);
    if (coordinates === false) return sendError(res, 400, "INVALID_INPUT", "Destination coordinates are invalid.");
    const donation = await Donation.findOneAndUpdate(
      { _id: req.params.id, status: "Available", expiryTime: { $gt: new Date() } },
      {
        $set: {
          status: "Reserved",
          claimedBy: req.user._id,
          destinationAddress,
          destinationCoordinates: coordinates || undefined,
          deliveryStatus: "AVAILABLE"
        }
      },
      { returnDocument: "after", runValidators: true }
    );
    if (!donation) return sendError(res, 409, "TASK_UNAVAILABLE", "This donation is no longer available.");
    const populated = await populatedDonations(Donation.findById(donation._id));
    const result = serializeDonation(populated, req.user);
    const riders = await User.find({ role: "Rider" }).select("_id");
    await notifyUsers(
      [result.donorId, req.user._id, ...riders.map((rider) => rider._id)],
      `A delivery task is available for ${result.foodName}.`,
      "assignment:available",
      { donationId: result.id }
    );
    return sendSuccess(res, result, 201);
  } catch (error) {
    return next(error);
  }
});

app.post("/api/v1/donations/:id/complete", authenticate, requireRole("NGO"), async (req, res, next) => {
  try {
    const donation = await Donation.findOneAndUpdate(
      { _id: req.params.id, status: "Reserved", claimedBy: req.user._id, rider: null, qrCode: String(req.body?.qrCode || "") },
      { $set: { status: "Completed", deliveryStatus: null, completedAt: new Date() } },
      { returnDocument: "after", runValidators: true }
    );
    if (!donation) return sendError(res, 409, "PICKUP_NOT_VERIFIED", "Pickup code is incorrect or this donation is assigned to a rider.");
    await notifyUsers([donation.donor], `${donation.foodName} was collected by ${req.user.name}.`, "donation:completed", { donationId: String(donation._id) });
    return sendSuccess(res, { id: String(donation._id), status: donation.status });
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/assignments/available", authenticate, requireRole("Rider"), async (req, res, next) => {
  try {
    const tasks = await populatedDonations(Donation.find({
      status: "Reserved",
      deliveryStatus: "AVAILABLE",
      rider: null,
      expiryTime: { $gt: new Date() }
    }).sort({ expiryTime: 1 }));
    return sendSuccess(res, tasks.map((item) => serializeDonation(item, req.user)));
  } catch (error) {
    return next(error);
  }
});

app.get("/api/v1/assignments/my-tasks", authenticate, requireRole("Rider"), async (req, res, next) => {
  try {
    const tasks = await populatedDonations(Donation.find({ rider: req.user._id }).sort({ updatedAt: -1 }));
    return sendSuccess(res, tasks.map((item) => serializeDonation(item, req.user)));
  } catch (error) {
    return next(error);
  }
});

app.post("/api/v1/assignments/:id/accept", authenticate, requireRole("Rider"), async (req, res, next) => {
  try {
    if (!req.user.available) return sendError(res, 403, "RIDER_UNAVAILABLE", "Set your availability to online before accepting a task.");
    const donation = await Donation.findOneAndUpdate(
      { _id: req.params.id, status: "Reserved", deliveryStatus: "AVAILABLE", rider: null },
      { $set: { rider: req.user._id, deliveryStatus: "ACCEPTED", acceptedAt: new Date() } },
      { returnDocument: "after", runValidators: true }
    );
    if (!donation) return sendError(res, 409, "TASK_UNAVAILABLE", "This delivery task has already been accepted or is no longer available.");
    await notifyUsers(
      [donation.donor, donation.claimedBy, req.user._id],
      `${donation.foodName} was assigned to a delivery partner.`,
      "assignment:assigned",
      { donationId: String(donation._id), riderId: String(req.user._id) }
    );
    const populated = await populatedDonations(Donation.findById(donation._id));
    return sendSuccess(res, serializeDonation(populated, req.user));
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/v1/assignments/:id/pickup", authenticate, requireRole("Rider"), async (req, res, next) => {
  try {
    const donation = await Donation.findOneAndUpdate(
      { _id: req.params.id, status: "Reserved", rider: req.user._id, deliveryStatus: "ACCEPTED" },
      { $set: { deliveryStatus: "PICKED_UP", pickedUpAt: new Date() } },
      { returnDocument: "after", runValidators: true }
    );
    if (!donation) return sendError(res, 409, "INVALID_TRANSITION", "Only the assigned rider can confirm pickup on an accepted delivery.");
    await notifyUsers(
      [donation.donor, donation.claimedBy, req.user._id],
      `${donation.foodName} has been picked up by the rider.`,
      "assignment:picked-up",
      { donationId: String(donation._id) }
    );
    const populated = await populatedDonations(Donation.findById(donation._id));
    return sendSuccess(res, serializeDonation(populated, req.user));
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/v1/assignments/:id/deliver", authenticate, requireRole("Rider"), async (req, res, next) => {
  try {
    const donation = await Donation.findOneAndUpdate(
      { _id: req.params.id, status: "Reserved", rider: req.user._id, deliveryStatus: "PICKED_UP" },
      { $set: { deliveryStatus: "DELIVERED", deliveredAt: new Date() } },
      { returnDocument: "after", runValidators: true }
    );
    if (!donation) return sendError(res, 409, "INVALID_TRANSITION", "Only the assigned rider can mark a picked-up delivery as delivered.");
    await notifyUsers(
      [donation.claimedBy, donation.donor, req.user._id],
      `${donation.foodName} was delivered. The NGO must confirm receipt.`,
      "assignment:delivered",
      { donationId: String(donation._id) }
    );
    const populated = await populatedDonations(Donation.findById(donation._id));
    return sendSuccess(res, serializeDonation(populated, req.user));
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/v1/assignments/:id/receipt", authenticate, requireRole("NGO"), async (req, res, next) => {
  try {
    const donation = await Donation.findOneAndUpdate(
      { _id: req.params.id, status: "Reserved", claimedBy: req.user._id, deliveryStatus: "DELIVERED" },
      { $set: { deliveryStatus: "COMPLETED", status: "Completed", completedAt: new Date() } },
      { returnDocument: "after", runValidators: true }
    );
    if (!donation) return sendError(res, 409, "INVALID_TRANSITION", "Only the receiving NGO can confirm a delivery marked as delivered.");
    await notifyUsers(
      [donation.rider, donation.donor, req.user._id],
      `${donation.foodName} was received and completed by the NGO.`,
      "assignment:completed",
      { donationId: String(donation._id) }
    );
    return sendSuccess(res, { id: String(donation._id), status: donation.deliveryStatus, completedAt: donation.completedAt });
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/v1/riders/me/availability", authenticate, requireRole("Rider"), async (req, res, next) => {
  try {
    if (typeof req.body?.available !== "boolean") return sendError(res, 400, "INVALID_INPUT", "Availability must be true or false.");
    req.user.available = req.body.available;
    await req.user.save();
    return sendSuccess(res, { available: req.user.available });
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/v1/admin/ngos/:id/approve", authenticate, requireRole("Admin"), async (req, res, next) => {
  try {
    const ngo = await User.findOneAndUpdate(
      { _id: req.params.id, role: "NGO" },
      { $set: { verified: true } },
      { returnDocument: "after" }
    );
    if (!ngo) return sendError(res, 404, "NOT_FOUND", "NGO account was not found.");
    await notifyUsers([ngo._id], "Your NGO account has been verified.", "ngo:verified", { userId: String(ngo._id) });
    return sendSuccess(res, { user: publicUser(ngo) });
  } catch (error) {
    return next(error);
  }
});

app.patch("/api/v1/admin/donations/:id/approve", authenticate, requireRole("Admin"), async (req, res, next) => {
  try {
    const donation = await Donation.findOneAndUpdate(
      {
        _id: req.params.id,
        status: "Reserved",
        claimedBy: null,
        rider: null,
        deliveryStatus: null
      },
      { $set: { status: "Available" } },
      { returnDocument: "after", runValidators: true }
    );
    if (!donation) {
      const existing = await Donation.findById(req.params.id);
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Donation request was not found.");
      return sendError(res, 409, "INVALID_TRANSITION", "This donation request is no longer waiting for approval.");
    }

    const riders = await User.find({ role: "Rider" }).select("_id");
    const donationId = String(donation._id);
    await notifyUsers(
      [donation.donor],
      `${donation.foodName} was approved and is now visible to verified NGOs.`
    );
    await notifyUsers(
      riders.map((rider) => rider._id),
      `${donation.foodName} was approved by Admin and is now visible to NGOs. You will be notified when an NGO claims it and the delivery task is ready.`,
      "donation:approved",
      { donationId }
    );
    return sendSuccess(res, { id: donationId, status: donation.status });
  } catch (error) {
    return next(error);
  }
});

app.delete("/api/v1/admin/donations/:id", authenticate, requireRole("Admin"), async (req, res, next) => {
  try {
    const donation = await Donation.findOneAndUpdate(
      { _id: req.params.id, status: { $in: ["Available", "Reserved"] } },
      { $set: { status: "Removed", deliveryStatus: "CANCELLED" } },
      { returnDocument: "after" }
    );
    if (!donation) {
      const existing = await Donation.findById(req.params.id);
      if (!existing) return sendError(res, 404, "NOT_FOUND", "Donation listing was not found.");
      return sendError(res, 409, "CANNOT_CANCEL", "Only open or active donations can be cancelled.");
    }
    await notifyUsers(
      [donation.donor, donation.claimedBy, donation.rider],
      `${donation.foodName} was cancelled by an administrator.`,
      "assignment:cancelled",
      { donationId: String(donation._id) }
    );
    return sendSuccess(res, { id: String(donation._id), status: donation.status });
  } catch (error) {
    return next(error);
  }
});

io.use((socket, next) => {
  try {
    const cookies = String(socket.handshake.headers.cookie || "").split(";");
    const entry = cookies.find((item) => item.trim().startsWith(`${cookieName}=`));
    const token = entry ? decodeURIComponent(entry.trim().slice(cookieName.length + 1)) : "";
    const claims = verifyToken(token);
    if (!claims) return next(new Error("unauthorized"));
    socket.data.user = claims;
    return next();
  } catch {
    return next(new Error("unauthorized"));
  }
});

io.on("connection", (socket) => {
  socket.join(`user:${socket.data.user.sub}`);
});

app.use((req, res) => sendError(res, 404, "NOT_FOUND", "The requested endpoint was not found."));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.status === 400 && error.type === "entity.parse.failed") {
    return sendError(res, 400, "INVALID_JSON", "Request body must contain valid JSON.");
  }
  if (error.status === 413) return sendError(res, 413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
  if (error.name === "ValidationError" || error.name === "CastError") {
    return sendError(res, 400, "INVALID_INPUT", "The request contains invalid data.");
  }
  if (error.name === "MongoServerSelectionError" || error.name === "MongooseServerSelectionError") {
    return sendError(res, 503, "DATABASE_UNAVAILABLE", "The database is temporarily unavailable.");
  }
  console.error(error);
  return sendError(res, 500, "INTERNAL_ERROR", "An unexpected server error occurred.");
});

async function start() {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI must be configured before starting FoodBridge.");
  if (!process.env.FOODBRIDGE_JWT_SECRET || process.env.FOODBRIDGE_JWT_SECRET.length < 32) {
    throw new Error("FOODBRIDGE_JWT_SECRET must be set to at least 32 characters.");
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const port = Number(process.env.PORT || 5173);
  await new Promise((resolve) => httpServer.listen(port, "127.0.0.1", resolve));
  console.log(`FoodBridge running at http://127.0.0.1:${port}`);
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  app,
  httpServer,
  io,
  start,
  signToken,
  verifyToken,
  donationApprovalStatus,
  validCoordinates,
  allowedOrigins
};
