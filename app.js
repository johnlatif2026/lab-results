const express = require("express");
const session = require("express-session");
const multer = require("multer");
const { CloudinaryStorage } = require("multer-storage-cloudinary");
const cloudinary = require("cloudinary").v2;
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const path = require("path");
require("dotenv").config();

const admin = require("firebase-admin");

// Firebase
if (!process.env.FIREBASE_CONFIG) {
  console.log("❌ FIREBASE_CONFIG مش موجود");
  process.exit(1);
}

const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);

admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
});

const db = admin.firestore();

const app = express();

// ✅ تحديد مسار views بطريقة مضمونة
const viewsPath = path.join(__dirname, "views");
console.log("Views path:", viewsPath); // عشان تتأكد في logs

app.set("views", viewsPath);
app.set("view engine", "ejs");

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Session
const MemoryStore = require('memorystore')(session);

// استبدل إعدادات Session بهذا
app.use(session({
  secret: process.env.SESSION_SECRET || "secret-key",
  resave: false,
  saveUninitialized: true,  // غير من false إلى true
  cookie: {
    secure: false,  // خليها false للتجربة على Vercel (لأنها HTTP مؤقتًا)
    maxAge: 86400000
  }
}));

// Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer + Cloudinary
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: "lab-results",
    resource_type: "auto",
    public_id: (req, file) => Date.now() + "-" + file.originalname,
  },
});

const upload = multer({ storage });

// Firestore functions
async function loadResults() {
  const snapshot = await db.collection("results").get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function addResult(id, result) {
  await db.collection("results").doc(id).set(result);
}

async function deleteResult(id) {
  await db.collection("results").doc(id).delete();
}

async function findResultsByPhone(phone) {
  const snapshot = await db.collection("results").where("phone", "==", phone).get();
  return snapshot.docs.map(doc => doc.data());
}

// Email
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_ADDRESS,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Routes
app.get("/", (req, res) => {
  res.render("index");
});

app.post("/result", async (req, res) => {
  const phone = req.body.phone;
  const filteredResults = await findResultsByPhone(phone);
  res.render("result", {
    result: filteredResults,
    phoneNumber: phone
  });
});

app.get("/view/:id", async (req, res) => {
  const doc = await db.collection("results").doc(req.params.id).get();
  const data = doc.data();
  if (!data) return res.send("Not found");
  res.redirect(data.file);
});

// Admin
app.get("/admin", async (req, res) => {
  console.log("===== DEBUGGING SESSION =====");
  console.log("Session ID:", req.session.id);
  console.log("Session loggedIn:", req.session.loggedIn);
  console.log("Full session:", req.session);
  console.log("==============================");
  
  if (req.session.loggedIn) {
    console.log("User is logged in, loading dashboard");
    try {
      const results = await loadResults();
      console.log(`Loaded ${results.length} results`);
      res.render("admin/dashboard", { results });
    } catch (error) {
      console.error("Error loading dashboard:", error);
      res.status(500).send("Error loading dashboard: " + error.message);
    }
  } else {
    console.log("User not logged in, showing login page");
    res.render("admin/login");
  }
});

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;
  console.log("Login attempt:", username);
  
  if (
    username === (process.env.ADMIN_USERNAME || "john") &&
    password === (process.env.ADMIN_PASSWORD || "latif")
  ) {
    req.session.loggedIn = true;
    console.log("Login successful, session saved:", req.session);
    
    // حفظ الجلسة بشكل صريح قبل إعادة التوجيه
    req.session.save((err) => {
      if (err) console.error("Session save error:", err);
      console.log("Session saved, redirecting to /admin");
      res.redirect("/admin");
    });
  } else {
    console.log("Login failed");
    res.send("بيانات الدخول غير صحيحة.");
  }
});

app.get("/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/admin");
  });
});

// Upload
app.post("/admin/upload", upload.single("pdf"), async (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/admin");

  const { name, phone, email, test, notes } = req.body;
  const fileUrl = req.file.path;
  const public_id = req.file.filename;
  const id = public_id;

  const newResult = {
    name,
    test,
    phone,
    email,
    notes: notes || "",
    file: fileUrl,
    public_id,
    date: new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })
  };

  await addResult(id, newResult);
  const link = `https://${req.get('host')}/`;

  const mailOptions = {
    from: process.env.EMAIL_ADDRESS,
    to: email,
    subject: "نتيجة التحاليل الخاصة بك",
    text: `مرحبًا ${name}\n\nنتيجتك جاهزة: ${link}\n${notes || ""}`,
  };

  transporter.sendMail(mailOptions, (error) => {
    if (error) console.log("❌ Email Error:", error);
    res.redirect("/admin");
  });
});

// Delete
app.post("/admin/delete", async (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/admin");

  const id = req.body.file;
  const doc = await db.collection("results").doc(id).get();
  const result = doc.data();

  if (result?.public_id) {
    await cloudinary.uploader.destroy(result.public_id, { resource_type: "raw" });
  }

  await deleteResult(id);
  res.redirect("/admin");
});

// Notify
app.post("/admin/notify", async (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/admin");

  const id = req.body.file;
  const snapshot = await db.collection("results").doc(id).get();
  const result = snapshot.data();

  if (!result) return res.send("غير موجود");

  const mailOptions = {
    from: process.env.EMAIL_ADDRESS,
    to: result.email,
    subject: "تم حذف النتيجة",
    text: `تم حذف نتيجتك.`,
  };

  transporter.sendMail(mailOptions, () => {
    res.redirect("/admin");
  });
});

module.exports = app;
