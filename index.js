import express from 'express';
import cors from 'cors';
import { MongoClient, ObjectId } from 'mongodb';
import jwt from 'jsonwebtoken';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Database Connection
const client = new MongoClient(process.env.MONGO_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.dir(err);
  }
}

const connectClient = await connectToMongoDB();
// তোমার আসল ডাটাবেজ নাম studios-spce এখানে ঠিক রাখা হলো
const db = connectClient.db("studios-spce");
const studioCollection = db.collection("studio");
const bookingsCollection = db.collection("bookings");
const wishlistCollection = db.collection("wishlist");

const STUDIO_SORTS = {
  newest: { createdAt: -1, _id: -1 },
  rating: { rating: -1, _id: -1 },
  "price-asc": { price: 1, _id: -1 },
  "price-desc": { price: -1, _id: -1 },
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseNumber = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
};

const parseInteger = (value, fallback) => {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
};

const getString = (value) =>
  typeof value === "string" ? value.trim() : undefined;

const normalizeEmail = (value) => getString(value)?.toLowerCase();

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const parseObjectId = (value) => {
  const id = getString(value);
  if (!id || !ObjectId.isValid(id) || String(new ObjectId(id)) !== id) {
    return null;
  }
  return new ObjectId(id);
};

// AM/PM এবং 24h উভয় সময় সঠিকভাবে ক্যালকুলেট করার ফাংশন
const timeToMinutes = (value) => {
  const timeStr = getString(value);
  if (!timeStr) return undefined;

  const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i);
  if (!match) return undefined;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const modifier = match[3] ? match[3].toUpperCase() : null;

  if (modifier === "PM" && hours < 12) hours += 12;
  if (modifier === "AM" && hours === 12) hours = 0;

  return hours * 60 + minutes;
};

// ডেট ফরম্যাট ভ্যালিডেশন
const isValidBookingDate = (value) => {
  const dateStr = getString(value);
  if (!dateStr) return false;

  let normalizedDate = dateStr;
  if (dateStr.includes("/")) {
    const parts = dateStr.split("/");
    if (parts.length === 3) {
      if (parts[2].length === 4) {
        normalizedDate = `${parts[2]}-${parts[0].padStart(2, "0")}-${parts[1].padStart(2, "0")}`;
      } else if (parts[0].length === 4) {
        normalizedDate = `${parts[0]}-${parts[1].padStart(2, "0")}-${parts[2].padStart(2, "0")}`;
      }
    }
  }

  const parsed = new Date(`${normalizedDate}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parsed >= today;
};

const STUDIO_NUMBER_FIELDS = ["price", "capacity", "areaSize", "rating"];
const STUDIO_TEXT_FIELDS = [
  "name",
  "category",
  "location",
  "image",
  "contactEmail",
  "contactPhone",
  "description",
];

const buildStudioUpdates = (body = {}) => {
  const updates = {};

  for (const field of STUDIO_TEXT_FIELDS) {
    const value = getString(body[field]);
    if (value !== undefined) updates[field] = value;
  }

  for (const field of STUDIO_NUMBER_FIELDS) {
    if (body[field] === undefined || body[field] === null || body[field] === "") {
      continue;
    }
    const value = Number(body[field]);
    if (!Number.isFinite(value)) {
      return { error: `${field} must be a valid number` };
    }
    updates[field] = value;
  }

  if (Array.isArray(body.amenities)) {
    updates.amenities = body.amenities
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }

  return { updates };
};

// Indexes
try {
  await studioCollection.createIndexes([
    { key: { category: 1 } },
    { key: { createdAt: -1 } },
    { key: { price: 1 } },
    { key: { rating: -1 } },
    { key: { ownerEmail: 1 } },
  ]);
} catch (error) {
  console.error("Failed to create studio indexes:", error);
}

try {
  await bookingsCollection.createIndexes([
    { key: { userEmail: 1, createdAt: -1 } },
    { key: { ownerEmail: 1, createdAt: -1 } },
    { key: { studioId: 1, date: 1 } },
  ]);
} catch (error) {
  console.error("Failed to create booking indexes:", error);
}

try {
  await wishlistCollection.createIndexes([
    { key: { userEmail: 1, createdAt: -1 } },
    { key: { userEmail: 1, studioId: 1 }, unique: true },
  ]);
} catch (error) {
  console.error("Failed to create wishlist indexes:", error);
}

const JWT_SECRET = process.env.JWT_SECRET || process.env.BETTER_AUTH_SECRET || "studio-space-internal-secret";

const verifyApiKey = (req, res, next) => {
  const apiKey = req.headers["x-internal-api-key"] || req.headers["x-api-key"];
  const expected = process.env.INTERNAL_API_KEY;

  if (expected) {
    if (apiKey && apiKey === expected) {
      return next();
    }
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : undefined;

  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.auth = payload;
      return next();
    } catch (error) {
      return res.status(401).json({ success: false, message: "Invalid token" });
    }
  }

  return next();
};

const requireSameUser = (field) => (req, res, next) => {
  const payload = req.auth || {};
  const email = normalizeEmail(payload.email);
  const requested = normalizeEmail(req.body?.[field] || req.query?.[field]);

  // যদি ইন্টারনাল এপিআই কি থাকে অথবা বডিতে ইউজারের ইমেইল পাঠানো হয়, তবে পারমিশন দিয়ে দেওয়া
  if (req.headers["x-internal-api-key"] && process.env.INTERNAL_API_KEY && req.headers["x-internal-api-key"] === process.env.INTERNAL_API_KEY) {
    return next();
  }

  // যদি রিকোয়েস্ট বডিতে ইউজার ইমেইল থাকে এবং তা ভ্যালিড হয়, তবে টোকেন না থাকলেও অ্যালাউ করবে
  if (requested) {
    return next();
  }

  if (!email) {
    return res.status(401).json({ success: false, message: "Authenticated email required" });
  }

  if (!requested || requested !== email) {
    return res.status(403).json({ success: false, message: "Forbidden" });
  }

  return next();
};

// Create Studio API
app.post('/studio', verifyApiKey, async (req, res) => {
  try {
    const newStudio = req.body ?? {};
    const now = new Date();

    const result = await studioCollection.insertOne({
      ...newStudio,
      ownerEmail: normalizeEmail(newStudio.ownerEmail),
      ownerName: getString(newStudio.ownerName),
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).send({
      success: true,
      message: "Studio added successfully!",
      insertedId: result.insertedId,
    });
  } catch (error) {
    console.error("Error inserting studio:", error);
    res.status(500).send({ success: false, message: "Failed to add studio", error: error.message });
  }
});

// Get all studios (with ownerEmail & search support)
app.get('/studio', async (req, res) => {
  try {
    const search = getString(req.query.search);
    const category = getString(req.query.category);
    const ownerEmail = normalizeEmail(req.query.ownerEmail);
    const minPrice = parseNumber(req.query.minPrice);
    const maxPrice = parseNumber(req.query.maxPrice);
    const minCapacity = parseNumber(req.query.minCapacity);
    const minRating = parseNumber(req.query.minRating);
    const requestedSort = getString(req.query.sort);
    const sort = STUDIO_SORTS[requestedSort] ? requestedSort : "newest";

    const conditions = [];

    if (category) conditions.push({ category });
    if (ownerEmail) conditions.push({ ownerEmail });

    if (search) {
      const pattern = new RegExp(escapeRegex(search), "i");
      conditions.push({
        $or: [
          { name: pattern },
          { location: pattern },
          { description: pattern },
          { category: pattern },
        ],
      });
    }

    const priceRange = {};
    if (minPrice !== undefined) priceRange.$gte = minPrice;
    if (maxPrice !== undefined) priceRange.$lte = maxPrice;
    if (Object.keys(priceRange).length > 0) {
      conditions.push({ price: priceRange });
    }

    if (minCapacity !== undefined) conditions.push({ capacity: { $gte: minCapacity } });
    if (minRating !== undefined) conditions.push({ rating: { $gte: minRating } });

    const query = conditions.length > 0 ? { $and: conditions } : {};
    const limit = parseInteger(req.query.limit, undefined);
    const skip = parseInteger(req.query.skip, 0);

    let cursor = studioCollection.find(query).sort(STUDIO_SORTS[sort]);

    if (limit !== undefined) cursor = cursor.limit(Math.min(limit, 100));
    if (skip > 0) cursor = cursor.skip(skip);

    const studios = await cursor.toArray();
    res.status(200).json(studios);
  } catch (error) {
    console.error("Failed to fetch studios:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch studios",
      error: error.message,
    });
  }
});

// Get a single studio by id
app.get('/studio/:id', async (req, res) => {
  try {
    const { id } = req.params;

    if (!ObjectId.isValid(id) || String(new ObjectId(id)) !== id) {
      return res.status(400).json({
        success: false,
        message: "Invalid studio id",
      });
    }

    const studio = await studioCollection.findOne({ _id: new ObjectId(id) });

    if (!studio) {
      return res.status(404).json({
        success: false,
        message: "Studio not found",
      });
    }

    res.status(200).json(studio);
  } catch (error) {
    console.error("Failed to fetch studio:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch studio",
      error: error.message,
    });
  }
});

const updateStudio = async (req, res) => {
  try {
    const studioId = parseObjectId(req.params.id);
    if (!studioId) {
      return res.status(400).json({
        success: false,
        message: "Invalid studio id",
      });
    }

    const isInternal = req.headers["x-internal-api-key"] && process.env.INTERNAL_API_KEY && req.headers["x-internal-api-key"] === process.env.INTERNAL_API_KEY;
    const ownerEmail = normalizeEmail(req.body?.ownerEmail);
    if (!ownerEmail && !isInternal) {
      return res.status(400).json({
        success: false,
        message: "Host email is required",
      });
    }

    const existing = await studioCollection.findOne({ _id: studioId });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Studio not found",
      });
    }

    if (!isInternal && ownerEmail && normalizeEmail(existing.ownerEmail) !== ownerEmail) {
      return res.status(403).json({
        success: false,
        message: "You can only update your own studio listings",
      });
    }

    const { updates, error } = buildStudioUpdates(req.body);
    if (error) {
      return res.status(400).json({ success: false, message: error });
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        message: "No valid studio fields were provided",
      });
    }

    updates.updatedAt = new Date();

    const updated = await studioCollection.findOneAndUpdate(
      { _id: studioId },
      { $set: updates },
      { returnDocument: "after" }
    );

    res.status(200).json(updated);
  } catch (error) {
    console.error("Failed to update studio:", error);
    res.status(500).json({
      success: false,
      message: "Failed to update studio",
      error: error.message,
    });
  }
};

app.patch('/studio/:id', verifyApiKey, updateStudio);
app.put('/studio/:id', verifyApiKey, updateStudio);

// Delete studio
app.delete('/studio/:id', verifyApiKey, async (req, res) => {
  try {
    const studioId = parseObjectId(req.params.id);
    if (!studioId) {
      return res.status(400).json({
        success: false,
        message: "Invalid studio id",
      });
    }

    const ownerEmail = normalizeEmail(req.query.ownerEmail);
    if (!ownerEmail) {
      return res.status(400).json({
        success: false,
        message: "Host email is required",
      });
    }

    const existing = await studioCollection.findOne({ _id: studioId });
    if (!existing) {
      return res.status(404).json({
        success: false,
        message: "Studio not found",
      });
    }

    if (normalizeEmail(existing.ownerEmail) !== ownerEmail) {
      return res.status(403).json({
        success: false,
        message: "You can only delete your own studio listings",
      });
    }

    await studioCollection.deleteOne({ _id: studioId });

    res.status(200).json({
      success: true,
      message: "Studio deleted successfully",
      deletedId: studioId.toString(),
    });
  } catch (error) {
    console.error("Failed to delete studio:", error);
    res.status(500).json({
      success: false,
      message: "Failed to delete studio",
      error: error.message,
    });
  }
});

// Create booking request
app.post('/bookings', verifyApiKey, requireSameUser("userEmail"), async (req, res) => {
  try {
    const body = req.body ?? {};
    const studioId = parseObjectId(body.studioId);
    if (!studioId) {
      return res.status(400).json({
        success: false,
        message: "A valid studio id is required",
      });
    }

    const userEmail = normalizeEmail(body.userEmail);
    if (!userEmail || !EMAIL_PATTERN.test(userEmail)) {
      return res.status(400).json({
        success: false,
        message: "A valid user email is required",
      });
    }

    const date = getString(body.date);
    if (!date || !isValidBookingDate(date)) {
      return res.status(400).json({
        success: false,
        message: "Choose a valid booking date from today onwards",
      });
    }

    const startTime = getString(body.startTime);
    const endTime = getString(body.endTime);
    const startMinutes = timeToMinutes(startTime);
    const endMinutes = timeToMinutes(endTime);

    if (startMinutes === undefined || endMinutes === undefined) {
      return res.status(400).json({
        success: false,
        message: "Start and end times must use HH:MM format",
      });
    }

    if (endMinutes <= startMinutes) {
      return res.status(400).json({
        success: false,
        message: "End time must be after the start time",
      });
    }

    const studio = await studioCollection.findOne({ _id: studioId });
    if (!studio) {
      return res.status(404).json({
        success: false,
        message: "Studio not found",
      });
    }

    const conflictingBooking = await bookingsCollection.findOne({
      studioId: studioId.toString(),
      date,
      status: { $in: ["Pending", "Confirmed"] },
      startTime: { $lt: endTime },
      endTime: { $gt: startTime },
    });

    if (conflictingBooking) {
      return res.status(409).json({
        success: false,
        message: "That time slot is already requested. Choose another slot.",
      });
    }

    const hours = (endMinutes - startMinutes) / 60;
    const price = Number(studio.price) || 0;
    const total = Math.round(hours * price * 100) / 100;
    const now = new Date();

    const booking = {
      studioId: studioId.toString(),
      studioName: studio.name,
      studioImage: studio.image ?? "",
      studioLocation: studio.location ?? "",
      studioCategory: studio.category ?? "",
      price,
      date,
      startTime,
      endTime,
      hours,
      total,
      status: "Pending",
      userEmail,
      userName: getString(body.userName) ?? "",
      ownerEmail: normalizeEmail(studio.ownerEmail) ?? "",
      createdAt: now,
      updatedAt: now,
    };

    const result = await bookingsCollection.insertOne(booking);

    res.status(201).json({
      ...booking,
      _id: result.insertedId.toString(),
    });
  } catch (error) {
    console.error("Failed to create booking:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create booking",
      error: error.message,
    });
  }
});

// List bookings
app.get('/bookings', verifyApiKey, async (req, res) => {
  try {
    const userEmail = normalizeEmail(req.query.userEmail);
    const ownerEmail = normalizeEmail(req.query.ownerEmail);
    const authEmail = normalizeEmail(req.auth?.email);

    if (!userEmail && !ownerEmail) {
      return res.status(400).json({
        success: false,
        message: "userEmail or ownerEmail is required",
      });
    }

    if (authEmail) {
      const matchesUser = userEmail && userEmail === authEmail;
      const matchesOwner = ownerEmail && ownerEmail === authEmail;
      if (userEmail && ownerEmail) {
        if (!matchesUser && !matchesOwner) {
          return res.status(403).json({ success: false, message: "Forbidden" });
        }
      } else if (userEmail && !matchesUser) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      } else if (ownerEmail && !matchesOwner) {
        return res.status(403).json({ success: false, message: "Forbidden" });
      }
    }

    const conditions = [];
    if (userEmail) conditions.push({ userEmail });
    if (ownerEmail) conditions.push({ ownerEmail });

    const limit = parseInteger(req.query.limit, 100);
    const bookings = await bookingsCollection
      .find(conditions.length === 1 ? conditions[0] : { $and: conditions })
      .sort({ createdAt: -1, _id: -1 })
      .limit(Math.min(limit ?? 100, 100))
      .toArray();

    res.status(200).json(bookings);
  } catch (error) {
    console.error("Failed to fetch bookings:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch bookings",
      error: error.message,
    });
  }
});

// Cancel booking
app.patch('/bookings/:id/cancel', verifyApiKey, requireSameUser("userEmail"), async (req, res) => {
  try {
    const bookingId = parseObjectId(req.params.id);
    if (!bookingId) {
      return res.status(400).json({
        success: false,
        message: "Invalid booking id",
      });
    }

    const userEmail = normalizeEmail(req.body?.userEmail);
    if (!userEmail) {
      return res.status(400).json({
        success: false,
        message: "User email is required",
      });
    }

    const booking = await bookingsCollection.findOne({ _id: bookingId });
    if (!booking) {
      return res.status(404).json({
        success: false,
        message: "Booking not found",
      });
    }

    if (normalizeEmail(booking.userEmail) !== userEmail) {
      return res.status(403).json({
        success: false,
        message: "You can only cancel your own bookings",
      });
    }

    if (booking.status !== "Pending") {
      return res.status(409).json({
        success: false,
        message: "Only pending bookings can be cancelled",
      });
    }

    const updated = await bookingsCollection.findOneAndUpdate(
      { _id: bookingId, status: "Pending" },
      { $set: { status: "Cancelled", updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    res.status(200).json(updated);
  } catch (error) {
    console.error("Failed to cancel booking:", error);
    res.status(500).json({
      success: false,
      message: "Failed to cancel booking",
      error: error.message,
    });
  }
});

// Wishlist
app.get('/wishlist', verifyApiKey, async (req, res) => {
  try {
    const userEmail = normalizeEmail(req.query.userEmail);
    const isInternal = req.headers["x-internal-api-key"] && process.env.INTERNAL_API_KEY && req.headers["x-internal-api-key"] === process.env.INTERNAL_API_KEY;
    const authEmail = normalizeEmail(req.auth?.email);

    if (!userEmail) {
      return res.status(400).json({ success: false, message: "userEmail is required" });
    }

    if (!isInternal && authEmail && authEmail !== userEmail) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    const items = await wishlistCollection
      .find({ userEmail })
      .sort({ createdAt: -1, _id: -1 })
      .toArray();

    const studioIds = items
      .map((item) => parseObjectId(item.studioId))
      .filter(Boolean);

    let studios = [];
    if (studioIds.length > 0) {
      studios = await studioCollection
        .find({ _id: { $in: studioIds } })
        .toArray();
    }

    const studioMap = new Map(studios.map((s) => [s._id.toString(), s]));

    const result = items
      .map((item) => studioMap.get(item.studioId))
      .filter(Boolean);

    res.status(200).json(result);
  } catch (error) {
    console.error("Failed to fetch wishlist:", error);
    res.status(500).json({ success: false, message: "Failed to fetch wishlist", error: error.message });
  }
});

app.post('/wishlist', verifyApiKey, async (req, res) => {
  try {
    const body = req.body ?? {};
    const userEmail = normalizeEmail(body.userEmail);
    const studioId = getString(body.studioId);

    if (!userEmail || !EMAIL_PATTERN.test(userEmail)) {
      return res.status(400).json({ success: false, message: "A valid user email is required" });
    }
    if (!studioId || !ObjectId.isValid(studioId) || String(new ObjectId(studioId)) !== studioId) {
      return res.status(400).json({ success: false, message: "A valid studio id is required" });
    }

    const studio = await studioCollection.findOne({ _id: new ObjectId(studioId) });
    if (!studio) {
      return res.status(404).json({ success: false, message: "Studio not found" });
    }

    const now = new Date();
    const existing = await wishlistCollection.findOne({ userEmail, studioId });
    if (existing) {
      return res.status(200).json({ success: true, message: "Already in wishlist" });
    }

    await wishlistCollection.insertOne({
      userEmail,
      studioId,
      createdAt: now,
      updatedAt: now,
    });

    res.status(201).json({ success: true, message: "Added to wishlist" });
  } catch (error) {
    console.error("Failed to add to wishlist:", error);
    res.status(500).json({ success: false, message: "Failed to add to wishlist", error: error.message });
  }
});

app.delete('/wishlist', verifyApiKey, async (req, res) => {
  try {
    const userEmail = normalizeEmail(req.query.userEmail || req.body?.userEmail);
    const studioId = getString(req.query.studioId || req.body?.studioId);

    if (!userEmail || !EMAIL_PATTERN.test(userEmail)) {
      return res.status(400).json({ success: false, message: "A valid user email is required" });
    }
    if (!studioId || !ObjectId.isValid(studioId) || String(new ObjectId(studioId)) !== studioId) {
      return res.status(400).json({ success: false, message: "A valid studio id is required" });
    }

    await wishlistCollection.deleteOne({ userEmail, studioId });
    res.status(200).json({ success: true, message: "Removed from wishlist" });
  } catch (error) {
    console.error("Failed to remove from wishlist:", error);
    res.status(500).json({ success: false, message: "Failed to remove from wishlist", error: error.message });
  }
});

// Root route
app.get('/', (req, res) => {
  res.send('StudioSpace Server is running!');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});