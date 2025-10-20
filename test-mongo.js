// test-mongo.js
const { MongoClient } = require("mongodb");

const uri = "mongodb+srv://gdipdavoli_db_user:7bMONG5gpoZiGDur@cluster0aciacam.ab9phb7.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0ACIACAM";

async function run() {
  try {
    const client = new MongoClient(uri);
    await client.connect();
    console.log("✅ Conectado correctamente a MongoDB Atlas");
    await client.close();
  } catch (err) {
    console.error("❌ Error al conectar:", err);
  }
}

run();

