const mongoose = require("mongoose");

const coordinatesSchema = new mongoose.Schema({
  lat: { type: Number, min: -90, max: 90 },
  lng: { type: Number, min: -180, max: 180 }
}, { _id: false });

const donationSchema = new mongoose.Schema({
  foodName: { type: String, required: true, trim: true, maxlength: 120 },
  quantity: { type: Number, required: true, min: 1 },
  category: { type: String, required: true, trim: true, maxlength: 80 },
  donor: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  location: { type: String, required: true, trim: true, maxlength: 100 },
  address: { type: String, required: true, trim: true, maxlength: 240 },
  coordinates: { type: coordinatesSchema, default: undefined },
  destinationAddress: { type: String, trim: true, maxlength: 240, default: "" },
  destinationCoordinates: { type: coordinatesSchema, default: undefined },
  pickupBefore: { type: String, required: true },
  expiryTime: { type: Date, required: true },
  image: { type: String, default: "" },
  instructions: { type: String, trim: true, maxlength: 500, default: "" },
  status: { type: String, enum: ["Available", "Reserved", "Completed", "Removed"], default: "Available", index: true },
  claimedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
  deliveryStatus: { type: String, enum: ["AVAILABLE", "ACCEPTED", "PICKED_UP", "DELIVERED", "COMPLETED", "CANCELLED"], default: null, index: true },
  rider: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null, index: true },
  acceptedAt: { type: Date, default: null },
  pickedUpAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  qrCode: { type: String, default: "" }
}, { timestamps: true });

donationSchema.index({ status: 1, deliveryStatus: 1, createdAt: -1 });
donationSchema.index({ rider: 1, deliveryStatus: 1 });
donationSchema.index({ claimedBy: 1, deliveryStatus: 1 });

module.exports = mongoose.models.Donation || mongoose.model("Donation", donationSchema);
