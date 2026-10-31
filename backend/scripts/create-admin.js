const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const backendEnv = path.join(__dirname, "..", ".env");
const projectEnv = path.join(__dirname, "..", "..", ".env");
require("dotenv").config({ path: fs.existsSync(backendEnv) ? backendEnv : projectEnv });
const mongoose = require("mongoose");
const User = require("../models/User");

const scrypt = promisify(crypto.scrypt);

async function main() {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "";
  if (!process.env.MONGODB_URI || !email || password.length < 10) {
    throw new Error("Set MONGODB_URI, ADMIN_EMAIL, and an ADMIN_PASSWORD of at least 10 characters.");
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const existing = await User.findOne({ email });
  if (existing) throw new Error("An account already exists for ADMIN_EMAIL.");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scrypt(password, salt, 64);
  const admin = await User.create({
    name: "FoodBridge Admin",
    email,
    role: "Admin",
    verified: true,
    passwordHash: `${salt}:${hash.toString("hex")}`
  });
  console.log(`Administrator created: ${admin.email}`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error.message);
  await mongoose.disconnect();
  process.exitCode = 1;
});
