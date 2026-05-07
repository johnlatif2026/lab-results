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
// تغيير إعدادات storage في Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: "lab-results",
    resource_type: "auto", // ← غيرها من "raw" إلى "auto"
    allowed_formats: ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'],
    public_id: (req, file) => {
      // إزالة المسافات والأحرف الخاصة من اسم الملف
      const timestamp = Date.now();
      const originalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
      return `${timestamp}-${originalName}`;
    },
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
app.post("/admin/upload", (req, res, next) => {
  if (!req.session.loggedIn) {
    return res.redirect("/admin");
  }
  next();
}, upload.single("pdf"), async (req, res) => {
  if (!req.session.loggedIn) {
    return res.redirect("/admin");
  }

  try {
    if (!req.file) {
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
      return res.status(400).send("جميع الحقول مطلوبة");
    }

    // التحقق من أن الرابط صالح
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
      file: req.file.path, // الرابط المباشر من Cloudinary
      public_id: req.file.filename,
      original_filename: req.file.originalname,
      file_size: req.file.size,
      mime_type: req.file.mimetype,
      date: new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })
    };

    await addResult(cleanId, newResult);
    console.log("Result added with file URL:", req.file.path);

    // إرسال الإيميل
    const link = `https://${req.get('host')}/view/${cleanId}`;
    const mailOptions = {
      from: process.env.EMAIL_ADDRESS,
      to: email,
      subject: "نتيجة التحاليل الخاصة بك",
      html: `
        <h2>مرحباً ${name}</h2>
        <p>يمكنك الاطلاع على نتيجة التحليل الخاصة بك من خلال الرابط التالي:</p>
        <p><a href="${link}">${link}</a></p>
        ${notes ? `<p><strong>ملاحظات:</strong> ${notes}</p>` : ''}
        <p>مع تحيات مركز التحاليل الطبية</p>
      `,
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
// ✅ Upload route - النسخة النهائية الموحدة
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

    console.log("File uploaded successfully:", {
      path: req.file.path,
      filename: req.file.filename,
      originalname: req.file.originalname,
      size: req.file.size
    });

    const { name, phone, email, test, notes } = req.body;
    
    // التحقق من البيانات المطلوبة
    if (!name || !phone || !email || !test) {
      console.log("Missing required fields");
      return res.status(400).send("جميع الحقول مطلوبة");
    }

    // التحقق من أن الرابط صالح
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

    // تحديث الرابط لاستخدام المسار الصحيح
    const protocol = req.protocol === 'https' ? 'https' : 'http';
    const host = req.get('host');
    const link = `${protocol}://${host}/view/${cleanId}`;
    
    // إرسال الإيميل بصيغة HTML محسنة
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

    // إرسال الإيميل مع async/await
    try {
      await transporter.sendMail(mailOptions);
      console.log("Email sent successfully to:", email);
    } catch (emailError) {
      console.error("Email error (but file uploaded):", emailError.message);
      // لا نمنع الرفع بسبب خطأ في الإيميل
    }

    // حفظ الجلسة قبل التوجيه
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

// Delete
// Delete - معدل
app.post("/admin/delete", async (req, res) => {
  console.log("Delete - Session check:", req.session.loggedIn);
  if (!req.session.loggedIn) return res.redirect("/admin");

  const id = req.body.file;

  try {
    const doc = await db.collection("results").doc(id).get();
    const result = doc.data();

    if (result?.public_id) {
      // استخدم "auto" بدلاً من "raw" لتتناسب مع إعدادات الرفع
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

// مسار مباشر لعرض الملفات من Cloudinary مع معالجة الأخطاء
app.get("/view/:id", async (req, res) => {
  try {
    const doc = await db.collection("results").doc(req.params.id).get();
    const data = doc.data();
    
    if (!data || !data.file) {
      return res.status(404).send("الملف غير موجود");
    }
    
    let fileUrl = data.file;
    
    // معالجة أنواع مختلفة من الروابط
    if (fileUrl.includes('/image/upload/')) {
      fileUrl = fileUrl.replace('/image/upload/', '/raw/upload/');
    }
    
    // التحقق من وجود الملف قبل التوجيه
    try {
      // اختبار ما إذا كان الملف موجوداً
      const response = await axios.head(fileUrl);
      if (response.status === 200) {
        // إضافة معامل التحميل إذا طلب المستخدم
        if (req.query.download === 'true') {
          // توجيه مع إعدادات التحميل
          return res.redirect(fileUrl + '?download=1&filename=' + encodeURIComponent(data.original_filename || 'result.pdf'));
        }
        return res.redirect(fileUrl);
      } else {
        throw new Error('File not found');
      }
    } catch (error) {
      console.error("File check failed:", error.message);
      return res.status(404).send(`
        <h1>الملف غير موجود</h1>
        <p>عذراً، الملف الذي تبحث عنه غير موجود في الخادم.</p>
        <p>الرابط: ${fileUrl}</p>
        <a href="/">العودة للصفحة الرئيسية</a>
      `);
    }
    
  } catch (error) {
    console.error("View error:", error);
    res.status(500).send("حدث خطأ: " + error.message);
  }
});

module.exports = app;
