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
      servicesCollection.createIndex({ technicianEmail: 1, createdAt: -1 }),
      bookingsCollection.createIndex({ customerEmail: 1, createdAt: -1 }),
      bookingsCollection.createIndex({ customerEmail: 1, status: 1 }),
      bookingsCollection.createIndex({ technicianEmail: 1, status: 1, createdAt: -1 }),
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

app.get("/api/services/technician", verifyToken, verifyTechnician, async (req, res) => {
  try {
    if (!servicesCollection) return sendError(res, 500, "Unable to load your services right now.");
    const services = await servicesCollection.find(
      { technicianEmail: req.authUser.email },
      {
        projection: {
          _id: 1, title: 1, category: 1, description: 1, image: 1,
          basePrice: 1, estimatedDuration: 1, serviceMode: 1, serviceArea: 1,
          approvalStatus: 1, isAvailable: 1, createdAt: 1, rejectionReason: 1,
        },
      },
    ).sort({ createdAt: -1, _id: -1 }).toArray();
    return res.json({ services: services.map((service) => ({ ...service, id: service._id.toString(), _id: undefined })) });
  } catch {
    return sendError(res, 500, "Unable to load your services right now.");
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

function verifyTechnician(req, res, next) {
  if (req.authUser?.role !== "technician") return sendError(res, 403, "Forbidden");
  next();
}

const dashboardBookingStatuses = ["requested", "accepted", "in-progress", "completed", "rejected", "cancelled"];

app.get("/api/technician/dashboard/overview", verifyToken, verifyTechnician, async (req, res) => {
  try {
    if (!servicesCollection || !bookingsCollection) {
      return sendError(res, 500, "Unable to load the technician dashboard right now.");
    }

    const technicianEmail = req.authUser.email;
    const [serviceSummaryRows, bookingSummaryRows, recentRequests] = await Promise.all([
      servicesCollection.aggregate([
        { $match: { technicianEmail } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            approved: { $sum: { $cond: [{ $eq: ["$approvalStatus", "approved"] }, 1, 0] } },
            pendingApproval: { $sum: { $cond: [{ $eq: ["$approvalStatus", "pending"] }, 1, 0] } },
            unavailable: { $sum: { $cond: [{ $eq: ["$isAvailable", false] }, 1, 0] } },
          },
        },
        { $project: { _id: 0, total: 1, approved: 1, pendingApproval: 1, unavailable: 1 } },
      ]).toArray(),
      bookingsCollection.aggregate([
        { $match: { technicianEmail } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            requested: { $sum: { $cond: [{ $eq: ["$status", "requested"] }, 1, 0] } },
            accepted: { $sum: { $cond: [{ $eq: ["$status", "accepted"] }, 1, 0] } },
            inProgress: { $sum: { $cond: [{ $eq: ["$status", "in-progress"] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            rejected: { $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
          },
        },
        { $project: { _id: 0, total: 1, requested: 1, accepted: 1, inProgress: 1, completed: 1, rejected: 1, cancelled: 1 } },
      ]).toArray(),
      bookingsCollection.find(
        { technicianEmail },
        {
          projection: {
            _id: 1, serviceTitle: 1, serviceImage: 1, category: 1,
            customerName: 1, customerPhone: 1, preferredDate: 1,
            createdAt: 1, status: 1, paymentStatus: 1,
          },
        },
      ).sort({ createdAt: -1, _id: -1 }).limit(5).toArray(),
    ]);

    const serviceSummary = serviceSummaryRows[0] || { total: 0, approved: 0, pendingApproval: 0, unavailable: 0 };
    const bookingSummary = bookingSummaryRows[0] || { total: 0, requested: 0, accepted: 0, inProgress: 0, completed: 0, rejected: 0, cancelled: 0 };
    const byStatus = Object.fromEntries(dashboardBookingStatuses.map((status) => [
      status,
      status === "in-progress" ? bookingSummary.inProgress : bookingSummary[status] || 0,
    ]));

    return res.json({
      services: serviceSummary,
      bookings: { total: bookingSummary.total, byStatus },
      recentRequests: recentRequests.map((booking) => ({ ...booking, _id: booking._id.toString() })),
    });
  } catch {
    return sendError(res, 500, "Unable to load the technician dashboard right now.");
  }
});

function isImgBbImageUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const imageUrl = new URL(value);
    return imageUrl.protocol === "https:" && imageUrl.hostname === "i.ibb.co"
      && !imageUrl.port && !imageUrl.username && !imageUrl.password;
  } catch {
    return false;
  }
}

app.post("/api/services", verifyToken, verifyTechnician, express.json(), async (req, res) => {
  try {
    if (!servicesCollection) return sendError(res, 500, "Unable to submit this service right now.");

    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const category = typeof body.category === "string" ? body.category : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const estimatedDuration = typeof body.estimatedDuration === "string" ? body.estimatedDuration.trim() : "";
    const serviceMode = typeof body.serviceMode === "string" ? body.serviceMode : "";
    const serviceArea = typeof body.serviceArea === "string" ? body.serviceArea.trim() : "";
    const basePrice = typeof body.basePrice === "number" ? body.basePrice : Number.NaN;

    if (title.length < 3 || title.length > 100) return sendError(res, 400, "Service title must be between 3 and 100 characters.");
    if (!allowedCategories.includes(category)) return sendError(res, 400, "Choose a valid service category.");
    if (!description || description.length > 2000) return sendError(res, 400, "Service description is required and must be 2000 characters or fewer.");
    if (!Number.isFinite(basePrice) || basePrice <= 0) return sendError(res, 400, "Base price must be greater than zero.");
    if (!estimatedDuration || estimatedDuration.length > 80) return sendError(res, 400, "Estimated duration is required and must be 80 characters or fewer.");
    if (!allowedModes.includes(serviceMode)) return sendError(res, 400, "Choose a valid service mode.");
    if (serviceArea.length < 2 || serviceArea.length > 100) return sendError(res, 400, "Service area must be between 2 and 100 characters.");
    if (!isImgBbImageUrl(body.image)) return sendError(res, 400, "Upload a valid service image before submitting.");

    const service = {
      title,
      category,
      description,
      image: body.image,
      basePrice,
      estimatedDuration,
      serviceMode,
      serviceArea,
      technicianName: req.authUser.name,
      technicianEmail: req.authUser.email,
      approvalStatus: "pending",
      isAvailable: true,
      createdAt: new Date(),
    };
    const result = await servicesCollection.insertOne(service);
    return res.status(201).json({ id: result.insertedId.toString(), ...service, technicianEmail: undefined });
  } catch {
    return sendError(res, 500, "Unable to submit this service right now.");
  }
});

app.patch("/api/services/:id", verifyToken, verifyTechnician, express.json(), async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return sendError(res, 400, "Invalid service ID.");
    if (!servicesCollection) return sendError(res, 500, "Unable to update this service right now.");

    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const ownership = { _id: new ObjectId(id), technicianEmail: req.authUser.email };

    // Availability is a separate single-field update and never changes approval.
    if (Object.keys(body).length === 1 && Object.prototype.hasOwnProperty.call(body, "isAvailable")) {
      if (typeof body.isAvailable !== "boolean") return sendError(res, 400, "Availability must be true or false.");
      const result = await servicesCollection.updateOne(ownership, { $set: { isAvailable: body.isAvailable } });
      if (!result.matchedCount) return sendError(res, 404, "Service not found.");
      return res.json({ message: "Service availability updated." });
    }

    const title = typeof body.title === "string" ? body.title.trim() : "";
    const category = typeof body.category === "string" ? body.category : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const estimatedDuration = typeof body.estimatedDuration === "string" ? body.estimatedDuration.trim() : "";
    const serviceMode = typeof body.serviceMode === "string" ? body.serviceMode : "";
    const serviceArea = typeof body.serviceArea === "string" ? body.serviceArea.trim() : "";
    const basePrice = typeof body.basePrice === "number" ? body.basePrice : Number.NaN;

    if (title.length < 3 || title.length > 100) return sendError(res, 400, "Service title must be between 3 and 100 characters.");
    if (!allowedCategories.includes(category)) return sendError(res, 400, "Choose a valid service category.");
    if (!description || description.length > 2000) return sendError(res, 400, "Service description is required and must be 2000 characters or fewer.");
    if (!Number.isFinite(basePrice) || basePrice <= 0) return sendError(res, 400, "Base price must be greater than zero.");
    if (!estimatedDuration || estimatedDuration.length > 80) return sendError(res, 400, "Estimated duration is required and must be 80 characters or fewer.");
    if (!allowedModes.includes(serviceMode)) return sendError(res, 400, "Choose a valid service mode.");
    if (serviceArea.length < 2 || serviceArea.length > 100) return sendError(res, 400, "Service area must be between 2 and 100 characters.");
    if (body.image !== undefined && !isImgBbImageUrl(body.image)) return sendError(res, 400, "Choose a valid ImgBB service image.");

    const updates = {
      title, category, description, basePrice, estimatedDuration,
      serviceMode, serviceArea, approvalStatus: "pending", updatedAt: new Date(),
    };
    if (body.image !== undefined) updates.image = body.image;
    const result = await servicesCollection.updateOne(ownership, { $set: updates });
    if (!result.matchedCount) return sendError(res, 404, "Service not found.");
    return res.json({ message: "Service updated and submitted for admin approval." });
  } catch {
    return sendError(res, 500, "Unable to update this service right now.");
  }
});

app.delete("/api/services/:id", verifyToken, verifyTechnician, async (req, res) => {
  try {
    const { id } = req.params;
    if (!ObjectId.isValid(id)) return sendError(res, 400, "Invalid service ID.");
    if (!servicesCollection) return sendError(res, 500, "Unable to delete this service right now.");
    const result = await servicesCollection.deleteOne({ _id: new ObjectId(id), technicianEmail: req.authUser.email });
    if (!result.deletedCount) return sendError(res, 404, "Service not found.");
    return res.json({ message: "Service deleted successfully." });
  } catch {
    return sendError(res, 500, "Unable to delete this service right now.");
  }
});

app.patch("/api/users/profile", verifyToken, async (req, res) => {
  try {
    if (!usersCollection) return sendError(res, 500, "Unable to update your profile right now.");

    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const nameLength = Array.from(name).length;
    if (nameLength < 2 || nameLength > 60) {
      return sendError(res, 400, "Name must be between 2 and 60 characters.");
    }

    let phone = "";
    if (body.phone !== undefined && typeof body.phone !== "string") {
      return sendError(res, 400, "Enter a valid phone number");
    }
    if (typeof body.phone === "string" && body.phone.trim()) {
      phone = body.phone.replace(/[\s-]/g, "");
      if (!/^\+?\d{7,15}$/.test(phone)) return sendError(res, 400, "Enter a valid phone number");
    }

    const area = body.area === undefined ? "" : typeof body.area === "string" ? body.area.trim() : null;
    if (area === null || area.length > 100) return sendError(res, 400, "Area must be 100 characters or fewer.");

    const bio = body.bio === undefined ? "" : typeof body.bio === "string" ? body.bio.trim() : null;
    if (bio === null || bio.length > 300) return sendError(res, 400, "Bio must be 300 characters or fewer.");

    const updates = { name, phone, area, bio, updatedAt: new Date() };
    if (Object.prototype.hasOwnProperty.call(body, "image")) {
      if (!isImgBbImageUrl(body.image)) return sendError(res, 400, "Choose a valid ImgBB profile image.");
      updates.image = body.image;
    }

    const result = await usersCollection.updateOne({ email: req.authUser.email }, { $set: updates });
    if (!result.matchedCount) return sendError(res, 404, "Profile not found.");

    const user = await usersCollection.findOne(
      { email: req.authUser.email },
      { projection: { name: 1, email: 1, role: 1, image: 1, phone: 1, area: 1, bio: 1 } },
    );
    if (!user) return sendError(res, 404, "Profile not found.");

    return res.json({
      name: user.name || "",
      email: user.email,
      role: user.role || "customer",
      image: user.image || null,
      phone: user.phone || "",
      area: user.area || "",
      bio: user.bio || "",
    });
  } catch {
    return sendError(res, 500, "Unable to update your profile right now.");
  }
});

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
    const listStatuses = ["requested", "accepted", "in-progress", "completed"];
    if (typeof req.query.status === "string" && listStatuses.includes(req.query.status)) filter.status = req.query.status;

    const [bookings, [summaryResult]] = await Promise.all([
      bookingsCollection.find(filter)
        .project({ _id: 1, serviceId: 1, serviceTitle: 1, serviceImage: 1, category: 1, technicianName: 1, preferredDate: 1, basePrice: 1, finalAmount: 1, status: 1, paymentStatus: 1, createdAt: 1 })
        .sort({ createdAt: -1, _id: -1 })
        .toArray(),
      bookingsCollection.aggregate([
        { $match: { customerEmail: req.authUser.email } },
        { $facet: {
          counts: [{ $group: {
            _id: null,
            all: { $sum: 1 },
            requested: { $sum: { $cond: [{ $eq: ["$status", "requested"] }, 1, 0] } },
            accepted: { $sum: { $cond: [{ $eq: ["$status", "accepted"] }, 1, 0] } },
            "in-progress": { $sum: { $cond: [{ $eq: ["$status", "in-progress"] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, 1, 0] } },
            rejected: { $sum: { $cond: [{ $eq: ["$status", "rejected"] }, 1, 0] } },
            cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
          } },
          { $project: { _id: 0, all: 1, requested: 1, accepted: 1, "in-progress": 1, completed: 1, rejected: 1, cancelled: 1 } },
        ],
          pendingLatest: [
            { $match: { status: "requested" } },
            { $sort: { createdAt: -1, _id: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, latestTitle: { $ifNull: ["$serviceTitle", "$title"] } } },
          ],
          inProgressLatest: [
            { $match: { status: "in-progress" } },
            { $sort: { createdAt: -1, _id: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, latestTitle: { $ifNull: ["$serviceTitle", "$title"] } } },
          ],
          paymentDue: [
            { $match: { status: "completed", paymentStatus: "unpaid" } },
            { $group: { _id: null, count: { $sum: 1 }, totalAmount: { $sum: "$finalAmount" } } },
            { $project: { _id: 0, count: 1, totalAmount: 1 } },
          ],
          paymentDueLatest: [
            { $match: { status: "completed", paymentStatus: "unpaid" } },
            { $sort: { createdAt: -1, _id: -1 } },
            { $limit: 1 },
            { $project: { _id: 0, latestTitle: { $ifNull: ["$serviceTitle", "$title"] } } },
          ],
        } },
      ]).toArray(),
    ]);

    const counts = summaryResult?.counts?.[0] || { all: 0, requested: 0, accepted: 0, "in-progress": 0, completed: 0, rejected: 0, cancelled: 0 };
    const due = summaryResult?.paymentDue?.[0] || { count: 0, totalAmount: 0 };
    return res.json({
      bookings: bookings.map((booking) => ({ ...booking, _id: String(booking._id), ...(booking.serviceId ? { serviceId: String(booking.serviceId) } : {}) })),
      counts,
      highlights: {
        pendingRequests: { count: counts.requested, latestTitle: summaryResult?.pendingLatest?.[0]?.latestTitle || null },
        inProgress: { count: counts["in-progress"], latestTitle: summaryResult?.inProgressLatest?.[0]?.latestTitle || null },
        paymentDue: { count: due.count || 0, totalAmount: due.totalAmount || 0, latestTitle: summaryResult?.paymentDueLatest?.[0]?.latestTitle || null },
      },
    });
  } catch {
    return sendError(res, 500, "Unable to load bookings right now.");
  }
});

app.get("/api/bookings/my/summary", verifyToken, verifyCustomer, async (req, res) => {
  if (!bookingMatch(req, res)) return;
  try {
    const groupedStatuses = await bookingsCollection.aggregate([
      { $match: { customerEmail: req.authUser.email } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).toArray();
    const byStatus = {
      requested: 0,
      accepted: 0,
      "in-progress": 0,
      completed: 0,
      rejected: 0,
      cancelled: 0,
    };
    for (const entry of groupedStatuses) {
      if (Object.hasOwn(byStatus, entry._id)) byStatus[entry._id] = entry.count;
    }
    const total = groupedStatuses.reduce((sum, entry) => sum + entry.count, 0);
    const active = byStatus.requested + byStatus.accepted + byStatus["in-progress"];
    return res.json({
      total,
      active,
      completed: byStatus.completed,
      byStatus,
    });
  } catch {
    return sendError(res, 500, "Unable to load booking summary right now.");
  }
});

app.get("/api/bookings/technician", verifyToken, verifyTechnician, async (req, res) => {
  if (!bookingMatch(req, res)) return;
  try {
    const statuses = ["requested", "accepted", "in-progress", "completed", "rejected", "cancelled"];
    const filter = { technicianEmail: req.authUser.email };
    const requestedStatus = typeof req.query.status === "string" ? req.query.status : "";
    if (statuses.includes(requestedStatus)) filter.status = requestedStatus;

    const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 100) : "";
    if (search) {
      const pattern = new RegExp(escapeSearch(search), "i");
      filter.$or = [
        { serviceTitle: pattern },
        { customerName: pattern },
        { customerEmail: pattern },
      ];
    }

    const sortKey = typeof req.query.sort === "string" ? req.query.sort : "newest";
    const sort = {
      oldest: { createdAt: 1, _id: 1 },
      preferred_earliest: { preferredDate: 1, createdAt: -1, _id: -1 },
      preferred_latest: { preferredDate: -1, createdAt: -1, _id: -1 },
    }[sortKey] || { createdAt: -1, _id: -1 };

    const [bookings, grouped] = await Promise.all([
      bookingsCollection.find(filter)
        .project({
          _id: 1, serviceId: 1, serviceTitle: 1, serviceImage: 1, category: 1,
          serviceMode: 1, serviceArea: 1, customerName: 1, customerEmail: 1,
          customerPhone: 1, address: 1, preferredDate: 1, problemDescription: 1,
          basePrice: 1, finalAmount: 1, status: 1, paymentStatus: 1, createdAt: 1,
        })
        .sort(sort)
        .toArray(),
      bookingsCollection.aggregate([
        { $match: { technicianEmail: req.authUser.email } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]).toArray(),
    ]);

    const counts = Object.fromEntries(statuses.map((status) => [status, 0]));
    for (const entry of grouped) if (Object.hasOwn(counts, entry._id)) counts[entry._id] = entry.count;
    counts.all = grouped.reduce((sum, entry) => sum + entry.count, 0);

    return res.json({
      bookings: bookings.map((booking) => ({
        ...booking,
        _id: String(booking._id),
        ...(booking.serviceId ? { serviceId: String(booking.serviceId) } : {}),
      })),
      counts,
    });
  } catch {
    return sendError(res, 500, "Unable to load repair requests right now.");
  }
});

app.patch("/api/bookings/:id/status", verifyToken, verifyTechnician, express.json(), async (req, res) => {
  if (!bookingMatch(req, res)) return;
  const { id } = req.params;
  if (!ObjectId.isValid(id)) return sendError(res, 400, "Invalid booking ID.");

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  const nextStatus = body.status;
  const allowedNextStatuses = {
    requested: ["accepted", "rejected"],
    accepted: ["in-progress"],
    "in-progress": ["completed"],
  };
  if (typeof nextStatus !== "string" || !Object.values(allowedNextStatuses).flat().includes(nextStatus)) {
    return sendError(res, 400, "Invalid booking status transition.");
  }
  if (nextStatus === "completed" && (typeof body.finalAmount !== "number" || !Number.isFinite(body.finalAmount) || body.finalAmount <= 0)) {
    return sendError(res, 400, "Final amount must be greater than zero.");
  }
  if (nextStatus !== "completed" && Object.prototype.hasOwnProperty.call(body, "finalAmount")) {
    return sendError(res, 400, "Final amount is only accepted when completing a job.");
  }

  try {
    const currentStatuses = Object.entries(allowedNextStatuses)
      .filter(([, targets]) => targets.includes(nextStatus))
      .map(([current]) => current);
    const update = { status: nextStatus, updatedAt: new Date() };
    if (nextStatus === "completed") update.finalAmount = Math.round(body.finalAmount * 100) / 100;

    const result = await bookingsCollection.updateOne(
      { _id: new ObjectId(id), technicianEmail: req.authUser.email, status: { $in: currentStatuses } },
      { $set: update },
    );
    if (!result.matchedCount) {
      const booking = await bookingsCollection.findOne({ _id: new ObjectId(id), technicianEmail: req.authUser.email }, { projection: { status: 1 } });
      if (!booking) return sendError(res, 404, "Booking not found.");
      return sendError(res, 400, "This booking can no longer move to that status.");
    }

    const booking = await bookingsCollection.findOne(
      { _id: new ObjectId(id), technicianEmail: req.authUser.email },
      { projection: {
        _id: 1, serviceId: 1, serviceTitle: 1, serviceImage: 1, category: 1,
        serviceMode: 1, serviceArea: 1, customerName: 1, customerEmail: 1,
        customerPhone: 1, address: 1, preferredDate: 1, problemDescription: 1,
        basePrice: 1, finalAmount: 1, status: 1, paymentStatus: 1, createdAt: 1,
      } },
    );
    return res.json({ booking: booking ? {
      ...booking,
      _id: String(booking._id),
      ...(booking.serviceId ? { serviceId: String(booking.serviceId) } : {}),
    } : null });
  } catch {
    return sendError(res, 500, "Unable to update this repair request right now.");
  }
});

app.patch("/api/bookings/:id/cancel", verifyToken, verifyCustomer, async (req, res) => {
  if (!bookingMatch(req, res)) return;
  if (!ObjectId.isValid(req.params.id)) return sendError(res, 400, "Invalid booking ID.");
  try {
    const result = await bookingsCollection.updateOne(
      { _id: new ObjectId(req.params.id), customerEmail: req.authUser.email, status: "requested" },
      { $set: { status: "cancelled" } },
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
    const [result] = await paymentsCollection.aggregate([
      { $match: { customerEmail: req.authUser.email } },
      { $facet: {
        payments: [
          { $sort: { paidAt: -1, _id: -1 } },
          { $project: { serviceTitle: 1, technicianName: 1, amount: 1, transactionId: 1, paidAt: 1 } },
        ],
        summary: [
          { $group: {
            _id: null,
            totalPaid: { $sum: "$amount" },
            count: { $sum: 1 },
            lastPaymentDate: { $max: "$paidAt" },
          } },
          { $project: { _id: 0, totalPaid: 1, count: 1, lastPaymentDate: 1 } },
        ],
        latest: [
          { $sort: { paidAt: -1, _id: -1 } },
          { $limit: 1 },
          { $project: { _id: 0, serviceTitle: 1, amount: 1 } },
        ],
      } },
    ]).toArray();
    const totals = result?.summary?.[0] || { totalPaid: 0, count: 0, lastPaymentDate: null };
    return res.json({
      payments: (result?.payments || []).map((payment) => ({
        id: String(payment._id),
        amount: payment.amount,
        transactionId: payment.transactionId,
        paidAt: payment.paidAt,
        serviceTitle: payment.serviceTitle,
        technicianName: payment.technicianName,
      })),
      summary: {
        totalPaid: totals.totalPaid || 0,
        count: totals.count || 0,
        lastPaymentDate: totals.lastPaymentDate || null,
        latest: result?.latest?.[0] || null,
      },
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
