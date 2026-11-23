import { MongoClient, ObjectId } from "mongodb";
import express from "express";
import cors from "cors";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 8000;
const clientOrigins = (process.env.CLIENT_ORIGIN || "").split(",").map((value) => value.trim()).filter(Boolean);
const mongoUri = process.env.MONGODB_URI || "";
const client = /^mongodb(\+srv)?:\/\//.test(mongoUri) ? new MongoClient(mongoUri) : null;

app.use(cors({ origin: clientOrigins.length ? clientOrigins : false }));

let studiocollection;
let servicesCollection;
let bookingsCollection;
let paymentsCollection;
let usersCollection;
let sessionsCollection;

export async function connectToMongoDB() {
  try {
    if (!client) return null;
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("MongoDB connection is not ready.");
    return null;
  }
}

const connectClient = await connectToMongoDB();
if (connectClient) {
  const db = connectClient.db("fixmate");
  servicesCollection = db.collection("services");
  bookingsCollection = db.collection("bookings");
  paymentsCollection = db.collection("payments");
  usersCollection = db.collection("user");
  sessionsCollection = db.collection("session");

  try {
    await Promise.all([
      servicesCollection.createIndex({ approvalStatus: 1, isAvailable: 1, createdAt: -1 }),
      servicesCollection.createIndex({ approvalStatus: 1, isAvailable: 1, basePrice: 1 }),
      bookingsCollection.createIndex({ customerEmail: 1, createdAt: -1 }),
      paymentsCollection.createIndex({ customerEmail: 1, paidAt: -1 }),
      paymentsCollection.createIndex({ stripeSessionId: 1 }, { unique: true, sparse: true }),
    ]);
  } catch (err) {
    console.error("Could not create service indexes.");
  }
}

const allowedCategories = ["Smartphone", "Laptop & PC", "AC", "Refrigerator", "TV", "Washing Machine", "Electrical"];
const allowedModes = ["Home Visit", "Shop Drop-off"];
const bookingStatuses = ["requested", "accepted", "in-progress", "completed", "rejected", "cancelled"];
const dashboardClientOrigin = process.env.CLIENT_ORIGIN?.split(",")[0]?.trim();

function escapeSearch(search) {
  return search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getPositiveInteger(value, fallback, maximum) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) return fallback;
  return Math.min(number, maximum);
}

function makePublicService(service) {
  const { _id, technicianEmail, ...fields } = service;
  void technicianEmail;
  return { id: _id.toString(), ...fields };
}

app.get(["/services", "/api/services"], async (req, res) => {
  try {
    if (!servicesCollection) {
      return res.status(500).json({ message: "Unable to load services right now." });
    }

    const filter = { approvalStatus: "approved", isAvailable: true };
    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    const category = typeof req.query.category === "string" ? req.query.category : "";
    const mode = typeof req.query.mode === "string" ? req.query.mode : "";
    const sortName = typeof req.query.sort === "string" ? req.query.sort : "newest";
    const page = getPositiveInteger(req.query.page, 1, 100000);
    const limit = getPositiveInteger(req.query.limit, 12, 24);

    if (search) {
      const safeSearch = escapeSearch(search);
      filter.$or = [
        { title: { $regex: safeSearch, $options: "i" } },
        { category: { $regex: safeSearch, $options: "i" } },
      ];
    }
    if (allowedCategories.includes(category)) filter.category = category;
    if (allowedModes.includes(mode)) filter.serviceMode = mode;

    let sort = { createdAt: -1, _id: -1 };
    if (sortName === "price_asc") sort = { basePrice: 1, _id: 1 };
    if (sortName === "price_desc") sort = { basePrice: -1, _id: 1 };

    const skip = (page - 1) * limit;
    const [services, total, availableCount] = await Promise.all([
      servicesCollection.find(filter).sort(sort).skip(skip).limit(limit).toArray(),
      servicesCollection.countDocuments(filter),
      servicesCollection.countDocuments({ approvalStatus: "approved", isAvailable: true }),
    ]);

    return res.json({
      services: services.map(makePublicService),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasAnyServices: availableCount > 0,
    });
  } catch (err) {
    console.error("Could not retrieve services.");
    return res.status(500).json({ message: "Unable to load services right now." });
  }
});

app.get(["/services/:id", "/api/services/:id"], async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid service ID." });
    }
    if (!servicesCollection) {
      return res.status(500).json({ message: "Unable to load this service right now." });
    }

    const service = await servicesCollection.findOne({
      _id: new ObjectId(id),
      approvalStatus: "approved",
      isAvailable: true,
    });
    if (!service) return res.status(404).json({ message: "Service not found." });
    return res.json({ service: makePublicService(service) });
  } catch (err) {
    console.error("Could not retrieve this service.");
    return res.status(500).json({ message: "Unable to load this service right now." });
  }
});

function sendError(res, status, message) {
  return res.status(status).json({ message });
}

async function verifyToken(req, res, next) {
  const authorization = req.headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
  if (!token || !sessionsCollection || !usersCollection) return sendError(res, 401, "Unauthorized");

  try {
    const session = await sessionsCollection.findOne({ token, expiresAt: { $gt: new Date() } });
    if (!session) return sendError(res, 401, "Unauthorized");
    let userId = session.userId;
    if (userId instanceof ObjectId) userId = userId.toString();
    const user = ObjectId.isValid(String(userId))
      ? await usersCollection.findOne({ _id: new ObjectId(String(userId)) })
      : await usersCollection.findOne({ _id: String(userId) });
    if (!user || !user.email) return sendError(res, 401, "Unauthorized");
    req.authUser = { id: String(userId), email: user.email, name: user.name, role: user.role || "customer" };
    next();
  } catch {
    return sendError(res, 401, "Unauthorized");
  }
}

function verifyCustomer(req, res, next) {
  if (req.authUser?.role !== "customer") return sendError(res, 403, "Forbidden");
  next();
}

function publicBooking(booking) {
  const { _id, ...fields } = booking;
  return { id: String(_id), ...fields };
}

function bookingMatch(req, res) {
  if (!bookingsCollection) {
    sendError(res, 500, "Unable to load bookings right now.");
    return false;
  }
  return true;
}

app.get("/api/bookings/my", verifyToken, verifyCustomer, async (req, res) => {
  if (!bookingMatch(req, res)) return;
  try {
    const filter = { customerEmail: req.authUser.email };
    if (typeof req.query.status === "string" && bookingStatuses.includes(req.query.status)) filter.status = req.query.status;
    const bookings = await bookingsCollection.find(filter).sort({ createdAt: -1, _id: -1 }).toArray();
    return res.json({ bookings: bookings.map(publicBooking) });
  } catch {
    return sendError(res, 500, "Unable to load bookings right now.");
  }
});

app.get("/api/bookings/my/summary", verifyToken, verifyCustomer, async (req, res) => {
  if (!bookingMatch(req, res)) return;
  try {
    const now = new Date();
    const firstMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
    const months = Array.from({ length: 6 }, (_, index) => {
      const date = new Date(Date.UTC(firstMonth.getUTCFullYear(), firstMonth.getUTCMonth() + index, 1));
      return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    });
    const [result] = await bookingsCollection.aggregate([
      { $match: { customerEmail: req.authUser.email } },
      { $facet: {
        counts: [{ $group: {
          _id: null,
          total: { $sum: 1 },
          requested: { $sum: { $cond: [{ $eq: ["$status", "requested"] }, 1, 0] } },
          accepted: { $sum: { $cond: [{ $eq: ["$status", "accepted"] }, 1, 0] } },
          inProgress: { $sum: { $cond: [{ $eq: ["$status", "in-progress"] }, 1, 0] } },
          completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] } },
          cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
        } }],
        monthly: [
          { $match: { createdAt: { $gte: firstMonth } } },
          { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, count: { $sum: 1 } } },
        ],
        readyToPay: [
          { $match: { status: "completed", paymentStatus: "unpaid" } },
          { $sort: { createdAt: -1, _id: -1 } },
          { $limit: 1 },
        ],
      } },
    ]).toArray();
    const counts = result?.counts?.[0] || {};
    const monthlyMap = new Map((result?.monthly || []).map((item) => [item._id, item.count]));
    return res.json({
      total: counts.total || 0,
      active: (counts.requested || 0) + (counts.accepted || 0) + (counts.inProgress || 0),
      completed: counts.completed || 0,
      byStatus: {
        requested: counts.requested || 0,
        accepted: counts.accepted || 0,
        "in-progress": counts.inProgress || 0,
        completed: counts.completed || 0,
        rejected: counts.rejected || 0,
        cancelled: counts.cancelled || 0,
      },
      perMonth: months.map((month) => ({ month, count: monthlyMap.get(month) || 0 })),
      readyToPay: result?.readyToPay?.[0] ? publicBooking(result.readyToPay[0]) : null,
    });
  } catch {
    return sendError(res, 500, "Unable to load booking summary right now.");
  }
});

app.patch("/api/bookings/:id/cancel", verifyToken, verifyCustomer, async (req, res) => {
  if (!bookingMatch(req, res)) return;
  if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "Invalid booking ID.");
  try {
    const result = await bookingsCollection.updateOne(
      { _id: new ObjectId(req.params.id), customerEmail: req.authUser.email, status: "requested" },
      { $set: { status: "cancelled", updatedAt: new Date() } },
    );
    if (!result.matchedCount) {
      const booking = await bookingsCollection.findOne({ _id: new ObjectId(req.params.id) });
      if (!booking || booking.customerEmail !== req.authUser.email) return sendError(res, 404, "Booking not found.");
      return sendError(res, 409, "Only requested bookings can be cancelled.");
    }
    return res.json({ message: "Booking cancelled." });
  } catch {
    return sendError(res, 500, "Unable to cancel this booking right now.");
  }
});

app.get("/api/payments/my", verifyToken, verifyCustomer, async (req, res) => {
  if (!paymentsCollection) return sendError(res, 500, "Unable to load payments right now.");
  try {
    const [payments, totals] = await Promise.all([
      paymentsCollection.find({ customerEmail: req.authUser.email }).sort({ paidAt: -1, _id: -1 }).toArray(),
      paymentsCollection.aggregate([
        { $match: { customerEmail: req.authUser.email } },
        { $group: { _id: null, totalPaid: { $sum: "$amount" }, count: { $sum: 1 } } },
      ]).toArray(),
    ]);
    return res.json({
      payments: payments.map((payment) => ({
        id: String(payment._id),
        bookingId: payment.bookingId,
        amount: payment.amount,
        transactionId: payment.transactionId,
        paidAt: payment.paidAt,
        serviceTitle: payment.serviceTitle,
        technicianName: payment.technicianName,
      })),
      totalPaid: totals[0]?.totalPaid || 0,
      count: totals[0]?.count || 0,
    });
  } catch {
    return sendError(res, 500, "Unable to load payments right now.");
  }
});

app.post("/api/payments/create-checkout-session", verifyToken, verifyCustomer, express.json(), async (req, res) => {
  const bookingId = req.body?.bookingId;
  if (typeof bookingId !== "string" || !ObjectId.isValid(bookingId)) return sendError(res, 400, "Invalid booking ID.");
  if (!bookingsCollection) return sendError(res, 500, "Unable to start checkout right now.");
  if (!process.env.STRIPE_SECRET_KEY || !dashboardClientOrigin) return sendError(res, 500, "Payment checkout is not configured.");
  try {
    const booking = await bookingsCollection.findOne({ _id: new ObjectId(bookingId) });
    if (!booking) return sendError(res, 404, "Booking not found.");
    if (booking.customerEmail !== req.authUser.email) return sendError(res, 403, "This booking does not belong to you.");
    if (booking.status !== "completed" || booking.paymentStatus !== "unpaid") return sendError(res, 400, "This booking is not ready for payment.");
    const amount = Number(booking.finalAmount);
    if (!Number.isFinite(amount) || amount <= 0) return sendError(res, 400, "The final booking amount is invalid.");

    const form = new URLSearchParams({
      mode: "payment",
      success_url: `${dashboardClientOrigin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${dashboardClientOrigin}/payment/cancel`,
      customer_email: req.authUser.email,
      client_reference_id: bookingId,
      "metadata[bookingId]": bookingId,
      "metadata[customerEmail]": req.authUser.email,
      "payment_intent_data[metadata][bookingId]": bookingId,
      "payment_intent_data[metadata][customerEmail]": req.authUser.email,
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": String(Math.round(amount * 100)),
      "line_items[0][price_data][product_data][name]": booking.serviceTitle || booking.title || "FixMate repair service",
    });
    const stripeResponse = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!stripeResponse.ok) return sendError(res, 502, "Unable to start payment checkout right now.");
    const checkout = await stripeResponse.json();
    if (typeof checkout.url !== "string") return sendError(res, 502, "Unable to start payment checkout right now.");
    return res.json({ url: checkout.url });
  } catch {
    return sendError(res, 500, "Unable to start payment checkout right now.");
  }
});

app.get("/api/payments/verify", verifyToken, verifyCustomer, async (req, res) => {
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : "";
  if (!sessionId.startsWith("cs_")) return sendError(res, 400, "Invalid checkout session.");
  if (!process.env.STRIPE_SECRET_KEY || !bookingsCollection || !paymentsCollection) return sendError(res, 500, "Unable to verify payment right now.");
  try {
    const stripeResponse = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    });
    if (!stripeResponse.ok) return sendError(res, 400, "Unable to verify this checkout session.");
    const checkout = await stripeResponse.json();
    const bookingId = checkout.metadata?.bookingId;
    if (checkout.metadata?.customerEmail !== req.authUser.email) return sendError(res, 403, "This payment does not belong to you.");
    if (!ObjectId.isValid(bookingId || "")) return sendError(res, 400, "Invalid booking reference.");
    const booking = await bookingsCollection.findOne({ _id: new ObjectId(bookingId), customerEmail: req.authUser.email });
    if (!booking) return sendError(res, 404, "Booking not found.");
    if (checkout.payment_status !== "paid") return sendError(res, 400, "Payment has not completed.");

    let payment = await paymentsCollection.findOne({ stripeSessionId: sessionId, customerEmail: req.authUser.email });
    if (!payment) {
      const created = {
        bookingId,
        customerEmail: req.authUser.email,
        amount: Number(checkout.amount_total || 0) / 100,
        transactionId: checkout.payment_intent || sessionId,
        stripeSessionId: sessionId,
        paidAt: checkout.created ? new Date(checkout.created * 1000) : new Date(),
        serviceTitle: booking.serviceTitle || booking.title || "Repair service",
        technicianName: booking.technicianName || "Technician",
      };
      try {
        const inserted = await paymentsCollection.insertOne(created);
        payment = { _id: inserted.insertedId, ...created };
      } catch (error) {
        if (error?.code !== 11000) throw error;
        payment = await paymentsCollection.findOne({ stripeSessionId: sessionId, customerEmail: req.authUser.email });
      }
    }
    await bookingsCollection.updateOne(
      { _id: new ObjectId(bookingId), customerEmail: req.authUser.email, status: "completed", paymentStatus: "unpaid" },
      { $set: { paymentStatus: "paid", paidAt: payment?.paidAt || new Date(), updatedAt: new Date() } },
    );
    return res.json({ amount: payment?.amount || Number(checkout.amount_total || 0) / 100, transactionId: payment?.transactionId || checkout.payment_intent || sessionId });
  } catch {
    return sendError(res, 500, "Unable to verify payment right now.");
  }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.parse.failed") return sendError(res, 400, "Invalid JSON request body.");
  return sendError(res, 500, "The request could not be completed right now.");
});

app.listen(PORT, () => {
  console.log(`The server is running on port ${PORT}`);
});
