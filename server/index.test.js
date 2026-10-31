const assert = require("node:assert/strict");
const { test } = require("node:test");
const mongoose = require("mongoose");
const Donation = require("./models/Donation");
const { httpServer, signToken, verifyToken, donationApprovalStatus } = require("./index");

test("session tokens validate signatures and expiration claims", () => {
  const originalSecret = process.env.FOODBRIDGE_JWT_SECRET;
  process.env.FOODBRIDGE_JWT_SECRET = "test-secret-with-at-least-thirty-two-characters";
  try {
    const token = signToken(new mongoose.Types.ObjectId(), "Rider");
    assert.equal(verifyToken(token).role, "Rider");
    const [header, payload, signature] = token.split(".");
    const changedSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
    assert.equal(verifyToken(`${header}.${payload}.${changedSignature}`), null);
    assert.equal(verifyToken("not-a-token"), null);
  } finally {
    if (originalSecret === undefined) delete process.env.FOODBRIDGE_JWT_SECRET;
    else process.env.FOODBRIDGE_JWT_SECRET = originalSecret;
  }
});

test("donation model enforces positive quantities and valid workflow statuses", async () => {
  const base = {
    foodName: "Prepared meals",
    quantity: 10,
    category: "Prepared Meals",
    donor: new mongoose.Types.ObjectId(),
    location: "Amritsar",
    address: "Market Road",
    pickupBefore: "18:00",
    expiryTime: new Date(Date.now() + 60_000)
  };
  await assert.doesNotReject(() => new Donation(base).validate());
  await assert.rejects(
    () => new Donation({ ...base, quantity: 0 }).validate(),
    /minimum/
  );
  await assert.rejects(
    () => new Donation({ ...base, deliveryStatus: "PICKED" }).validate(),
    /enum/
  );
});

test("donation approval reuses existing status fields without changing the model", () => {
  assert.equal(Donation.schema.path("approvalStatus"), undefined);
  assert.equal(donationApprovalStatus({ status: "Reserved", claimedBy: null, rider: null }), "PENDING");
  assert.equal(donationApprovalStatus({ status: "Available", claimedBy: null, rider: null }), "APPROVED");
  assert.equal(donationApprovalStatus({ status: "Reserved", claimedBy: new mongoose.Types.ObjectId(), rider: null }), "APPROVED");
});

test("local Live Server origins receive credentialed API CORS headers", async () => {
  const server = httpServer;
  const originalSecret = process.env.FOODBRIDGE_JWT_SECRET;
  process.env.FOODBRIDGE_JWT_SECRET = "test-secret-with-at-least-thirty-two-characters";
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const origin = "http://127.0.0.1:5500";
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${baseUrl}/api/v1/auth/session`, {
      headers: { Origin: origin }
    });
    const session = await response.json();
    assert.equal(response.status, 200);
    assert.equal(session.success, true);
    assert.equal(session.data.user, null);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.equal(response.headers.get("access-control-allow-credentials"), "true");

    const preflight = await fetch(`${baseUrl}/api/v1/auth/login`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type"
      }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), origin);

    const socketClient = await fetch(`${baseUrl}/socket.io/socket.io.js`, {
      headers: { Origin: origin }
    });
    assert.equal(socketClient.status, 200);
    assert.equal(socketClient.headers.get("access-control-allow-origin"), origin);
    assert.equal(socketClient.headers.get("access-control-allow-credentials"), "true");
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (originalSecret === undefined) delete process.env.FOODBRIDGE_JWT_SECRET;
    else process.env.FOODBRIDGE_JWT_SECRET = originalSecret;
  }
});
