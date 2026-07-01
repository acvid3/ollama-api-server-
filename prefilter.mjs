import { MongoClient } from "mongodb";

// --- Config ---
const MONGODB_URI = process.env.MONGODB_URI; // set in environment
const DB_NAME = process.env.DB_NAME;
const COLLECTION_NAME = process.env.COLLECTION_NAME; // populate this

// --- Disqualify if any of these appear in specialties (case-insensitive)
// These indicate the agency does technical work themselves
const DISQUALIFY_SPECIALTIES = [
  "web design",
  "web development",
  "web developer",
  "app development",
  "software development",
  "conception sites web",
  "automation",
  "ai",
  "artificial intelligence",
  "ux-ui design",
  "ux/ui",
  "ui/ux",
  "webflow",
  "woocommerce",
  "shopify development",
  "wordpress development",
];

// --- Disqualify if any of these appear in description (case-insensitive, whole phrase)
const DISQUALIFY_DESCRIPTION_PHRASES = [
  "web design",
  "web development",
  "we build websites",
  "we develop",
  "app development",
  "software development",
  "we create websites",
  "chatbot",
  "ai solutions",
  "automation solutions",
  "we automate",
  "custom development",
];

// --- Helpers ---

function normalise(str = "") {
  return str.toLowerCase().trim();
}

function specialtiesDisqualify(specialties = []) {
  return specialties.some((s) =>
    DISQUALIFY_SPECIALTIES.some((bad) => normalise(s).includes(bad))
  );
}

function descriptionDisqualifies(description = "") {
  const norm = normalise(description);
  return DISQUALIFY_DESCRIPTION_PHRASES.some((phrase) =>
    norm.includes(phrase)
  );
}

function companySizeDisqualifies(size = "") {
  // Keep: "2-10 employees", "11-50 employees"
  // Disqualify: "1 employee" (solo), "51-200", "201-500", etc.
  const norm = normalise(size);
  if (norm.includes("1 employee")) return true;
  if (norm.includes("51-200")) return true;
  if (norm.includes("201-500")) return true;
  if (norm.includes("501-1000")) return true;
  if (norm.includes("1001+")) return true;
  return false;
}

function hasWebsite(record) {
  const site = record.website || "";
  return site.trim().length > 0 && site !== "N/A";
}

function classify(record) {
  // Gate: company size
  if (companySizeDisqualifies(record.company_size)) {
    return { status: "disqualified", reason: "company size out of range" };
  }

  // Gate: specialties
  if (specialtiesDisqualify(record.specialties)) {
    return { status: "disqualified", reason: "offers technical services themselves" };
  }

  // Gate: description
  if (descriptionDisqualifies(record.description)) {
    return { status: "disqualified", reason: "description indicates technical capability" };
  }

  // Passed — route by website availability
  if (hasWebsite(record)) {
    return { status: "email", reason: "has website, run scoring agent" };
  }

  return { status: "linkedin", reason: "no website, LinkedIn outreach only" };
}

// --- Main ---

async function run() {
  if (!MONGODB_URI || !DB_NAME || !COLLECTION_NAME) {
    throw new Error("Missing MONGODB_URI, DB_NAME, or COLLECTION_NAME env vars");
  }

  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  console.log("Connected to MongoDB Atlas");

  const collection = client.db(DB_NAME).collection(COLLECTION_NAME);
  const total = await collection.countDocuments({});
  console.log(`Total records: ${total}`);

  const cursor = collection.find({});
  const counts = { disqualified: 0, linkedin: 0, email: 0 };
  let processed = 0;

  const bulkOps = [];

  while (await cursor.hasNext()) {
    const record = await cursor.next();
    const { status, reason } = classify(record);

    bulkOps.push({
      updateOne: {
        filter: { _id: record._id },
        update: {
          $set: {
            status,
            status_reason: reason,
            status_updated_at: new Date(),
          },
        },
      },
    });

    counts[status]++;
    processed++;

    // Flush every 500 records
    if (bulkOps.length === 500) {
      await collection.bulkWrite(bulkOps.splice(0, 500));
      console.log(`Processed ${processed}/${total}...`);
    }
  }

  // Flush remaining
  if (bulkOps.length > 0) {
    await collection.bulkWrite(bulkOps);
  }

  await client.close();

  console.log("\n--- Results ---");
  console.log(`Disqualified : ${counts.disqualified}`);
  console.log(`LinkedIn only: ${counts.linkedin}`);
  console.log(`Email (score): ${counts.email}`);
  console.log(`Total        : ${processed}`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
