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

// ✅ Session configuration
const MemoryStore = require('memorystore')(session);

app.use(session({
  secret: process.env.SESSION_SECRET || "secret-key",
  resave: true,
  saveUninitialized: true,
  cookie: {
    secure: false,
    maxAge: 86400000,
    httpOnly: true,
    sameSite: 'lax'
  },
  unset: 'keep'
}));

// ✅ Middleware لحماية الجلسة
app.use((req, res, next) => {
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

// ✅ Multer + Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "lab-results",
    resource_type: "auto", // ✅ المفتاح: "auto" بدلاً من "raw"
    access_mode: "public", // ✅ جعل الملف عاماً
    allowed_formats: ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'],
    public_id: (req, file) => {
      const timestamp = Date.now();
      const originalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
      return `${timestamp}-${originalName}`;
    },
  },
});

const upload = multer({ 
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024
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
    id: doc.id,
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

// ✅ Upload route - النسخة النهائية الموحدة
app.post("/admin/upload", (req, res, next) => {
  console.log("1. Checking session before multer:", req.session.loggedIn);
  if (!req.session.loggedIn) {
    console.log("Session check failed, redirecting to login");
    return res.redirect("/admin");
  }
  next();
}, upload.single("pdf"), async (req, res) => {
  console.log("2. Checking session after multer:", req.session.loggedIn);
  if (!req.session.loggedIn) {
    console.log("Session lost after multer! Redirecting to login");
    return res.redirect("/admin");
  }

  try {
    if (!req.file) {
      console.log("No file uploaded");
      return res.status(400).send("لم يتم رفع ملف");
    }

    console.log("File uploaded successfully:", {
      path: req.file.path,
      filename: req.file.filename,
      originalname: req.file.originalname,
      size: req.file.size
    });

    const { name, phone, email, test, notes } = req.body;
    
    if (!name || !phone || !email || !test) {
      console.log("Missing required fields");
      return res.status(400).send("جميع الحقول مطلوبة");
    }

    if (!req.file.path || !req.file.path.startsWith('http')) {
      throw new Error('Invalid file URL from Cloudinary');
    }

    const cleanId = Date.now().toString();
    
    const newResult = {
      name,
      test,
      phone,
      email,
      notes: notes || "",
      file: req.file.path,
      public_id: req.file.filename,
      original_filename: req.file.originalname,
      file_size: req.file.size,
      mime_type: req.file.mimetype,
      date: new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })
    };

    await addResult(cleanId, newResult);
    console.log("Result added to Firestore with ID:", cleanId);

    const protocol = req.protocol === 'https' ? 'https' : 'http';
    const host = req.get('host');
    const link = `${protocol}://${host}/view/${cleanId}`;
    
    const mailOptions = {
      from: process.env.EMAIL_ADDRESS,
      to: email,
      subject: "نتيجة التحاليل الخاصة بك",
      html: `
        <h2>مرحباً ${name}</h2>
        <p>تم إضافة نتيجة التحليل الخاصة بك إلى النظام.</p>
        <p>يمكنك الاطلاع عليها من خلال الرابط التالي:</p>
        <p><a href="${link}" style="background-color: #4CAF50; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">عرض النتيجة</a></p>
        <p>أو قم بنسخ هذا الرابط: ${link}</p>
        ${notes ? `<p><strong>ملاحظات:</strong> ${notes}</p>` : ''}
        <hr>
        <p>مع تحيات مركز التحاليل الطبية</p>
      `,
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log("Email sent successfully to:", email);
    } catch (emailError) {
      console.error("Email error (but file uploaded):", emailError.message);
    }

    req.session.save((err) => {
      if (err) console.error("Session save error:", err);
      console.log("3. Session saved, redirecting to /admin");
      res.redirect("/admin");
    });

  } catch (error) {
    console.error("Upload error details:", error);
    res.status(500).send(`
      <h1>حدث خطأ أثناء رفع الملف</h1>
      <p>${error.message}</p>
      <a href="/admin">العودة للوحة التحكم</a>
    `);
  }
});

// Delete route
app.post("/admin/delete", async (req, res) => {
  console.log("Delete - Session check:", req.session.loggedIn);
  if (!req.session.loggedIn) return res.redirect("/admin");

  const id = req.body.file;

  try {
    const doc = await db.collection("results").doc(id).get();
    const result = doc.data();

    if (result?.public_id) {
      await cloudinary.uploader.destroy(result.public_id, {
        resource_type: "auto",
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

// مسار عرض وتحميل الملفات (التصحيح النهائي)
// مسار عرض وتحميل الملفات (حل شامل للمشكلة)
app.get("/view/:id", async (req, res) => {
  try {
    const doc = await db.collection("results").doc(req.params.id).get();
    const data = doc.data();

    if (!data || !data.file) {
      return res.status(404).send("الملف غير موجود");
    }

    let fileUrl = data.file;
    let resourceType = "raw"; // القيمة الافتراضية

    // 1. تحديد نوع الملف من امتداده
    const fileExtension = path.extname(data.original_filename || fileUrl).toLowerCase();
    const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(fileExtension);
    const isPDF = fileExtension === '.pdf';
    
    if (isImage) {
        resourceType = "image";
    } else if (isPDF || !isImage) { // إذا كان PDF أو نوع آخر (مثل docx) نعتبره raw
        resourceType = "raw";
    }

    // 2. معالجة رابط Cloudinary ليتناسب مع نوع الملف.
    // إذا كان الرابط من Cloudinary، نصحح مسار type في الرابط.
    if (fileUrl.includes('res.cloudinary.com')) {
        // نحدد النمط المطلوب: /image/upload/ أو /raw/upload/
        const requiredTypePart = `/${resourceType}/upload/`;
        
        // نستبدل أي نوع موجود (image, video, raw) بالنوع الصحيح
        fileUrl = fileUrl.replace(/\/(image|video|raw)\/upload\//, requiredTypePart);
        
        console.log(`✅ تم تصحيح رابط الملف. النوع: ${resourceType}, الرابط: ${fileUrl}`);
    } else {
        console.log(`ℹ️ الرابط ليس من Cloudinary، يتم تمريره كما هو.`);
    }

    // 3. التحقق من صحة الرابط النهائي (اختياري ولكنه مفيد للتأكد)
    try {
        await axios.head(fileUrl);
    } catch (headError) {
        console.warn(`⚠️ فشل التحقق من الرابط: ${fileUrl} - ${headError.message}`);
        // لا نوقف التنفيذ هنا، ربما الرابط صحيح ولكن السيرفر لا يدعم HEAD requests
    }

    // 4. إعادة التوجيه أو تنزيل الملف
    if (req.query.download === 'true') {
        // إضافة fl_attachment=true ليجبر Cloudinary على التنزيل
        const downloadUrl = fileUrl.includes('res.cloudinary.com') 
                            ? fileUrl + (fileUrl.includes('?') ? '&' : '?') + 'fl_attachment=true'
                            : fileUrl;
        return res.redirect(downloadUrl);
    } else {
        // عرض في المتصفح
        return res.redirect(fileUrl);
    }

  } catch (error) {
    console.error("خطأ في مسار /view/:id", error);
    res.status(500).send(`
        <h1>⚠️ حدث خطأ أثناء محاولة عرض الملف</h1>
        <p>${error.message}</p>
        <a href="/admin">↩️ العودة للوحة التحكم</a>
    `);
  }
});

module.exports = app;
