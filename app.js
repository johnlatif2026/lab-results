const axios = require('axios');
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
console.log("Views path:", viewsPath);

app.set("views", viewsPath);
app.set("view engine", "ejs");

// ✅ Body parser middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// ✅ Session configuration - محسنة
const MemoryStore = require('memorystore')(session);

app.use(session({
  secret: process.env.SESSION_SECRET || "secret-key",
  resave: true,  // changed to true
  saveUninitialized: true,
  cookie: {
    secure: false,
    maxAge: 86400000,
    httpOnly: true,
    sameSite: 'lax'
  },
  unset: 'keep'  // منع حذف الجلسة
}));

// ✅ Middleware لحماية الجلسة
app.use((req, res, next) => {
  // تسجيل حالة الجلسة للـ admin routes
  if (req.path.startsWith('/admin')) {
    console.log(`[${req.method}] ${req.path} - Session ID: ${req.session.id}, LoggedIn: ${req.session.loggedIn}`);
  }
  next();
});

// Cloudinary Config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ✅ Multer + Cloudinary مع إعدادات الرفع العام (public upload)
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "lab-results",
    resource_type: "raw", // أو "auto"
    type: 'upload', // <-- هذه الخاصية ستجعل الملف عامًا ويمكن الوصول إليه مباشرة
    public_id: (req, file) => Date.now() + "-" + file.originalname,
  },
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB حد أقصى
  }
});

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
  return snapshot.docs.map(doc => ({ 
    id: doc.id,     // ✅ أضف هذا
    ...doc.data() 
  }));
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

// Admin routes
app.get("/admin", async (req, res) => {
  console.log("===== DEBUGGING SESSION =====");
  console.log("Session ID:", req.session.id);
  console.log("Session loggedIn:", req.session.loggedIn);
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

// ✅ Upload route - المحسن بالكامل
// Upload route - النسخة المعدلة
app.post("/admin/upload", (req, res, next) => {
  // التحقق من الجلسة قبل معالجة الملف
  console.log("1. Checking session before multer:", req.session.loggedIn);
  if (!req.session.loggedIn) {
    console.log("Session check failed, redirecting to login");
    return res.redirect("/admin");
  }
  next();
}, upload.single("pdf"), async (req, res) => {
  // التحقق مرة أخرى بعد multer
  console.log("2. Checking session after multer:", req.session.loggedIn);
  if (!req.session.loggedIn) {
    console.log("Session lost after multer! Redirecting to login");
    return res.redirect("/admin");
  }

  try {
    // التحقق من وجود الملف
    if (!req.file) {
      console.log("No file uploaded");
      return res.status(400).send("لم يتم رفع ملف");
    }

    const { name, phone, email, test, notes } = req.body;
    
    // التحقق من البيانات المطلوبة
    if (!name || !phone || !email || !test) {
      console.log("Missing required fields");
      return res.status(400).send("جميع الحقول مطلوبة");
    }

    console.log("Uploading file for:", name);
    const fileUrl = req.file.path;
    const public_id = req.file.filename;
    
    // ✅ تنظيف الـ ID ليكون صالح لـ Firestore
    // نأخذ الوقت والتاريخ فقط كـ ID نظيف
    const cleanId = Date.now().toString(); // ID بسيط ونظيف
    
    // أو ممكن تستخدم اسم منظم: اسم_المريض_الوقت
    // const cleanId = `${name.replace(/\s/g, '_')}_${Date.now()}`;

    console.log("Generated clean ID:", cleanId);
    console.log("Original filename:", req.file.originalname);

    const newResult = {
      name,
      test,
      phone,
      email,
      notes: notes || "",
      file: fileUrl,
      public_id: public_id, // نحتفظ بالاسم الأصلي للملف في Cloudinary
      original_filename: req.file.originalname, // نخزن الاسم الأصلي
      date: new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })
    };

    // استخدام الـ ID النظيف
    await addResult(cleanId, newResult);
    console.log("Result added to Firestore with ID:", cleanId);

    const link = `https://lab-results.vercel.app/`;
    const mailOptions = {
      from: process.env.EMAIL_ADDRESS,
      to: email,
      subject: "نتيجة التحاليل الخاصة بك",
      text: `مرحبًا ${name}\n\nيمكنك الاطلاع على النتيجة عبر الرابط:\n${link}\n\n${notes || ""}`,
    };

    // إرسال الإيميل
    transporter.sendMail(mailOptions, (error) => {
      if (error) console.log("❌ Email Error:", error);
      else console.log("Email sent successfully to:", email);
    });

    // حفظ الجلسة قبل التوجيه
    req.session.save((err) => {
      if (err) console.error("Session save error:", err);
      console.log("3. Session saved, redirecting to /admin");
      res.redirect("/admin");
    });

  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).send("حدث خطأ أثناء رفع الملف: " + error.message);
  }
});

// Delete
app.post("/admin/delete", async (req, res) => {
  console.log("Delete - Session check:", req.session.loggedIn);
  if (!req.session.loggedIn) return res.redirect("/admin");

  const id = req.body.file; // ده دلوقتي هو الـ cleanId مش اسم الملف

  try {
    const doc = await db.collection("results").doc(id).get();
    const result = doc.data();

    if (result?.public_id) {
      await cloudinary.uploader.destroy(result.public_id, {
        resource_type: "raw",
      });
      console.log("File deleted from Cloudinary:", result.public_id);
    }

    await deleteResult(id);
    console.log("Result deleted from Firestore:", id);
    
    req.session.save((err) => {
      if (err) console.error("Session save error:", err);
      res.redirect("/admin");
    });
  } catch (error) {
    console.error("Delete error:", error);
    res.status(500).send("حدث خطأ أثناء الحذف: " + error.message);
  }
});

// Notify
// Notify route - معدل
app.post("/admin/notify", async (req, res) => {
  console.log("Notify - Session check:", req.session.loggedIn);
  if (!req.session.loggedIn) return res.redirect("/admin");

  const id = req.body.file; // الـ cleanId
  
  try {
    const snapshot = await db.collection("results").doc(id).get();
    const result = snapshot.data();

    if (!result) return res.send("النتيجة غير موجودة");

    const mailOptions = {
      from: process.env.EMAIL_ADDRESS,
      to: result.email,
      subject: "تم حذف النتيجة",
      text: `تم حذف نتيجتك.`,
    };

    transporter.sendMail(mailOptions, (error) => {
      if (error) console.log("Email error:", error);
      else console.log("Notification email sent to:", result.email);
      
      req.session.save((err) => {
        if (err) console.error("Session save error:", err);
        res.redirect("/admin");
      });
    });
  } catch (error) {
    console.error("Notify error:", error);
    res.status(500).send("حدث خطأ: " + error.message);
  }
});

app.get("/view/:id", async (req, res) => {
  try {
    const doc = await db.collection("results").doc(req.params.id).get();
    const data = doc.data();
    
    if (!data || !data.file) {
      return res.status(404).send("الملف غير موجود");
    }
    
    // حول الرابط من image لـ raw لو كان PDF
    let fileUrl = data.file;
    if (fileUrl.includes('/image/upload/')) {
      fileUrl = fileUrl.replace('/image/upload/', '/raw/upload/');
    }
    
    res.redirect(fileUrl);
    
  } catch (error) {
    console.error(error);
    res.status(500).send("حدث خطأ");
  }
});

module.exports = app;
