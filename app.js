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
    resource_type: "raw", // ✅ غيرها من "auto" إلى "raw"
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
app.get("/view/:id", async (req, res) => {
  try {
    const doc = await db.collection("results").doc(req.params.id).get();
    const data = doc.data();
    
    if (!data || !data.file) {
      return res.status(404).send("الملف غير موجود");
    }
    
    let originalUrl = data.file;
    let finalUrl = originalUrl;
    
    // 🔧 المعالجة الذكية لأي رابط من Cloudinary
    if (originalUrl.includes('res.cloudinary.com')) {
      // إذا كان الرابط من نوع image أو video، نحوله إلى raw
      if (originalUrl.includes('/image/upload/') || originalUrl.includes('/video/upload/')) {
        finalUrl = originalUrl.replace(/\/(image|video)\/upload\//, '/raw/upload/');
        console.log(`📝 تم تصحيح الرابط من ${originalUrl} إلى ${finalUrl}`);
      }
      
      // إذا لم يكن يحتوي على /raw/upload/ نهائياً، نضيفه
      if (!finalUrl.includes('/raw/upload/') && finalUrl.includes('/upload/')) {
        finalUrl = finalUrl.replace('/upload/', '/raw/upload/');
        console.log(`📝 تم إضافة raw إلى الرابط: ${finalUrl}`);
      }
    }
    
    // التحقق النهائي من الملف
    try {
      const response = await axios.head(finalUrl);
      if (response.status === 200) {
        if (req.query.download === 'true') {
          return res.redirect(finalUrl + '?fl_attachment=true');
        }
        return res.redirect(finalUrl);
      }
    } catch (err) {
      console.log(`⚠️ فشل الوصول إلى ${finalUrl}`);
    }
    
    // إذا فشل الرابط المصحح، نعرض رسالة خطأ واضحة
    return res.status(404).send(`
      <h1>⚠️ لا يمكن الوصول إلى الملف</h1>
      <p><strong>السبب:</strong> تم رفع هذا الملف بنوع غير صحيح (image) بينما هو ملف PDF.</p>
      <p><strong>الحل:</strong> قم <strong>بحذف هذه النتيجة</strong> من لوحة التحكم، ثم <strong>أعد رفع الملف مرة أخرى</strong> بعد تعديل الكود.</p>
      <p>تم تعديل إعدادات الرفع الآن إلى <code>resource_type: "raw"</code>، لذلك الملفات الجديدة ستعمل بشكل صحيح.</p>
      <a href="/admin">↩️ العودة للوحة التحكم</a>
    `);
    
  } catch (error) {
    console.error(error);
    res.status(500).send("حدث خطأ: " + error.message);
  }
});

module.exports = app;
