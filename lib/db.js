const { MongoClient } = require('mongodb');
const crypto = require('crypto');

// Cache the connection across serverless invocations
const cached = global._mongo || (global._mongo = { client: null, promise: null });

const CANDIDATES = [
  'Aarya', 'Alicia', 'Suriya', 'Nancy', 'Navya', 'Renuka', 'Saafalya',
  'Sangamithra', 'Namyatha', 'Sumiran', 'Swati', 'Trisha', 'Gunjan',
];

async function getDb() {
  if (!cached.promise) {
    cached.client = new MongoClient(process.env.MONGODB_URI);
    cached.promise = cached.client
      .connect()
      .then(async (client) => {
        const db = client.db(process.env.MONGODB_DB || 'cr_election');
        // Make sure the collections exist (transactions can't create them)
        const existing = (await db.listCollections().toArray()).map((c) => c.name);
        for (const name of ['candidates', 'voters', 'ballots']) {
          if (!existing.includes(name)) {
            try { await db.createCollection(name); } catch (_) { /* created concurrently */ }
          }
        }
        await db.collection('candidates').bulkWrite(
          CANDIDATES.map((name, i) => ({
            updateOne: {
              filter: { _id: i + 1 },
              update: { $setOnInsert: { name } },
              upsert: true,
            },
          }))
        );
        return db;
      })
      .catch((err) => {
        cached.promise = null; // allow retry on next request
        throw err;
      });
  }
  return cached.promise;
}

// voters  -> WHO voted (no choice, no timestamp)
// ballots -> WHAT was chosen (random string _id, no voter, no timestamp)

async function getCandidates() {
  const db = await getDb();
  return db.collection('candidates')
    .find({}).sort({ _id: 1 }).toArray()
    .then((rows) => rows.map((r) => ({ id: r._id, name: r.name })));
}

async function hasVoted(roll) {
  const db = await getDb();
  return !!(await db.collection('voters').findOne({ _id: roll }, { projection: { _id: 1 } }));
}

// Atomic: voter record + ballot are committed together or not at all.
// voters._id = roll no, so a second vote hits a duplicate-key error (code 11000).
async function castVote(roll, name, candidateId) {
  const db = await getDb();
  const session = cached.client.startSession();
  try {
    await session.withTransaction(async () => {
      await db.collection('voters').insertOne({ _id: roll, name }, { session });
      await db.collection('ballots').insertOne(
        { _id: crypto.randomUUID(), candidateId },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }
}

async function getResults() {
  const db = await getDb();
  const counts = await db.collection('ballots').aggregate([
    { $group: { _id: '$candidateId', votes: { $sum: 1 } } },
  ]).toArray();
  const countMap = new Map(counts.map((c) => [c._id, c.votes]));

  const cands = await db.collection('candidates').find({}).toArray();
  const tallies = cands
    .map((c) => ({ id: c._id, name: c.name, votes: countMap.get(c._id) || 0 }))
    .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name));

  // sorted by roll no, NOT by time voted
  const voters = (await db.collection('voters').find({}).sort({ _id: 1 }).toArray())
    .map((v) => ({ roll_no: v._id, name: v.name }));

  return { tallies, voters };
}

module.exports = { getCandidates, hasVoted, castVote, getResults };