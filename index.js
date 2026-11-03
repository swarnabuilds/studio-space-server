import express from 'express';
import cors from 'cors';
import { MongoClient } from 'mongodb';
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
const db = connectClient.db("studios-spce");
const studioCollection = db.collection("studio");




// 2. Create / Add New Studio (POST API)
app.post('/studio', async (req, res) => {
  try {
    const newStudio = req.body;
    const result = await studioCollection.insertOne({
      ...newStudio,
      createdAt: new Date(),
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

// Root route
app.get('/', (req, res) => {
  res.send('StudioSpace Server is running running!');
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});