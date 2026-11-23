import { MongoClient, ObjectId } from 'mongodb';
import express from "express";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify } from "jose";
import 'dotenv/config'

const app = express();
const PORT = process.env.PORT || 8000;

const clientOrigin = process.env.CLIENT_ORIGIN;
app.use(cors({ origin: clientOrigin || false }));
app.use(express.json());


const client = process.env.MONGODB_URI
  ? new MongoClient(process.env.MONGODB_URI)
  : null;
let studiocollection;
let servicesCollection;
export async function connectToMongoDB() {
  try {
    if (!client) throw new Error("MONGODB_URI is not configured");
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

try {
  const connectClient = await connectToMongoDB();
  if (connectClient) {
    const db = connectClient.db("fixmate");
    servicesCollection = db.collection("services");
    await Promise.all([
      servicesCollection.createIndex({ approvalStatus: 1, isAvailable: 1, createdAt: -1 }),
      servicesCollection.createIndex({ approvalStatus: 1, isAvailable: 1, basePrice: 1 }),
    ]);
  }
} catch (err) {
  console.error("MongoDB connection is not ready.");
}

const allowedCategories = [
  "Smartphone",
  "Laptop & PC",
  "AC",
  "Refrigerator",
  "TV",
  "Washing Machine",
  "Electrical",
];
const allowedModes = ["Home Visit", "Shop Drop-off"];

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

app.get("/api/services", async (req, res) => {
  try {
    if (!servicesCollection) {
      return res.status(500).json({ message: "Unable to load services right now." });
    }

    const filter = { approvalStatus: "approved", isAvailable: true };
    const search = typeof req.query.search === "string"
      ? req.query.search.trim().slice(0, 100)
      : "";
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

app.get("/api/services/:id", async (req, res) => {
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




app.listen(PORT, ()=> {
    console.log(`The server is running on port ${PORT}`);
});
