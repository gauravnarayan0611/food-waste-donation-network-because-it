const mongoose = require("mongoose");

const notificationSchema = new mongoose.Schema({
  text: { type: String, required: true, maxlength: 240 },
  at: { type: Date, default: Date.now }
}, { _id: true });

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: ["Donor", "NGO", "Admin", "Rider"], required: true },
  city: { type: String, trim: true, maxlength: 80, default: "" },
  address: { type: String, trim: true, maxlength: 240, default: "" },
  phone: { type: String, trim: true, maxlength: 32, default: "" },
  coordinates: {
    lat: { type: Number, min: -90, max: 90 },
    lng: { type: Number, min: -180, max: 180 }
  },
  verified: { type: Boolean, default: true },
  available: { type: Boolean, default: false },
  notifications: { type: [notificationSchema], default: [] }
}, { timestamps: true });

userSchema.index({ role: 1, verified: 1, available: 1 });

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
