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
    resource_type: "raw", // ✅ المفتاح: "auto" بدلاً من "raw"
    access_mode: "public", // ✅ جعل الملف عاماً
    allowed_formats: ['pdf', 'jpg', 'jpeg', 'png', 'doc', 'docx'],
    public_id: (req, file) => {
      const timestamp = Date.now();
      const originalName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
      return `${timestamp}-${originalName}`;
    },
  },
});


const multerMemory = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB حد أقصى
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
  console.log("Session logedIn:", req.session.loggedIn);
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
app.post("/admin/upload", 
  // 1. التحقق من الجلسة أولاً
  (req, res, next) => {
    console.log("🔐 1. Checking session before upload:", req.session.loggedIn);
    if (!req.session.loggedIn) {
      console.log("❌ Session check failed, redirecting to login");
      return res.redirect("/admin");
    }
    next();
  },
  
  // 2. استقبال الملف في الذاكرة (بدون رفعه لـ Cloudinary فوراً)
  multerMemory.single("pdf"),
  
  // 3. معالجة الملف ورفعه يدوياً لـ Cloudinary
  async (req, res) => {
    console.log("📁 2. Processing file upload...");
    
    // التحقق من الجلسة مرة أخرى بعد multer
    if (!req.session.loggedIn) {
      console.log("❌ Session lost after multer! Redirecting to login");
      return res.redirect("/admin");
    }

    try {
      // التحقق من وجود ملف
      if (!req.file) {
        console.log("❌ No file uploaded");
        return res.status(400).send(`
          <script>
            alert('❌ لم يتم رفع ملف. يرجى اختيار ملف PDF أو صورة.');
            window.location.href = '/admin';
          </script>
        `);
      }

      console.log(`📄 File received: ${req.file.originalname}, Size: ${req.file.size} bytes, Type: ${req.file.mimetype}`);

      // استخراج البيانات من النموذج
      const { name, phone, email, test, notes } = req.body;
      
      if (!name || !phone || !email || !test) {
        console.log("❌ Missing required fields");
        return res.status(400).send(`
          <script>
            alert('❌ جميع الحقول مطلوبة (الاسم، الهاتف، البريد، نوع التحليل)');
            window.location.href = '/admin';
          </script>
        `);
      }

      // التحقق من صحة رقم الهاتف
      if (!/^[0-9]{10,11}$/.test(phone)) {
        return res.status(400).send(`
          <script>
            alert('❌ رقم الهاتف غير صحيح. يجب أن يكون 10 أو 11 رقمًا.');
            window.location.href = '/admin';
          </script>
        `);
      }

      // ========== رفع الملف إلى Cloudinary بطريقة موثوقة ==========
      console.log("☁️ 3. Uploading to Cloudinary...");
      
      // تحديد نوع الملف وتجهيز الخيارات
      const fileExtension = req.file.originalname.split('.').pop().toLowerCase();
      const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(fileExtension);
      const isPdf = fileExtension === 'pdf';
      
      // اختيار resource_type المناسب
let resourceType = 'auto';

if (isImage) resourceType = 'image';
if (isPdf) resourceType = 'raw';
      
      // تحضير public_id نظيف (بدون امتداد مزدوج)
      let baseName = req.file.originalname.replace(/\.[^/.]+$/, ''); // إزالة الامتداد
      baseName = baseName.replace(/[^a-zA-Z0-9\u0600-\u06FF\-_]/g, '_'); // تنظيف الأحرف (يدعم العربية)
      const publicId = `${Date.now()}-${baseName}`;
      
      // رفع الملف إلى Cloudinary باستخدام Promise
      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "lab-results",
            resource_type: resourceType,
            access_mode: "public",      // ✅ مفتاح الحل: يجعل الملف عاماً
            public_id: publicId,
            // للملفات raw نحتاج تحديد allowed_formats
            ...(resourceType === 'raw' && { allowed_formats: ['pdf', 'doc', 'docx'] })
          },
          (error, result) => {
            if (error) {
              console.error("❌ Cloudinary upload error:", error);
              reject(error);
            } else {
              console.log("✅ Cloudinary upload success:", result.secure_url);
              resolve(result);
            }
          }
        );
        
        // إرسال بيانات الملف (buffer)
        uploadStream.end(req.file.buffer);
      });
      
      // التحقق من نجاح الرفع
      if (!uploadResult || !uploadResult.secure_url) {
        throw new Error("فشل رفع الملف إلى Cloudinary - لم يتم استلام رابط صحيح");
      }
      
      console.log(`✅ File uploaded to Cloudinary: ${uploadResult.secure_url}`);
      console.log(`   Resource type: ${uploadResult.resource_type}, Public ID: ${uploadResult.public_id}`);
      
      // ========== حفظ البيانات في Firestore ==========
      const cleanId = Date.now().toString();
      
      const newResult = {
        name: name.trim(),
        test: test.trim(),
        phone: phone.trim(),
        email: email.trim().toLowerCase(),
        notes: notes || "",
        file: uploadResult.secure_url,           // الرابط العام الصحيح
        public_id: uploadResult.public_id,
        original_filename: req.file.originalname,
        file_size: req.file.size,
        mime_type: req.file.mimetype,
        resource_type: uploadResult.resource_type, // حفظ نوع الملف للمساعدة لاحقاً
        date: new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })
      };
      
      await addResult(cleanId, newResult);
      console.log(`📝 Result saved to Firestore with ID: ${cleanId}`);
      
      // ========== إرسال البريد الإلكتروني ==========
      const protocol = req.protocol === 'https' ? 'https' : 'http';
      const host = req.get('host');
      const link = `${protocol}://${host}/view/${cleanId}`;
      
      const mailOptions = {
        from: process.env.EMAIL_ADDRESS,
        to: email,
        subject: `نتيجة التحليل - ${test}`,
        html: `
          <div dir="rtl" style="font-family: 'Tahoma', sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
            <h2 style="color: #6a11cb;">مرحباً ${name}</h2>
            <p>تم إضافة نتيجة التحليل الخاصة بك إلى النظام.</p>
            <p><strong>نوع التحليل:</strong> ${test}</p>
            <p>يمكنك الاطلاع عليها من خلال الرابط التالي:</p>
            <p style="text-align: center;">
              <a href="${link}" style="display: inline-block; background-color: #6a11cb; color: white; padding: 12px 25px; text-decoration: none; border-radius: 8px;">📄 عرض النتيجة</a>
            </p>
            <p>أو قم بنسخ هذا الرابط: <a href="${link}">${link}</a></p>
            ${notes ? `<p><strong>📝 ملاحظات:</strong> ${notes}</p>` : ''}
            <hr style="margin: 20px 0;">
            <p style="color: #666; font-size: 12px;">مع تحيات مركز التحاليل الطبية</p>
          </div>
        `,
      };
      
      // إرسال البريد (لا ننتظر النتيجة حتى لا نؤخر الرد)
      transporter.sendMail(mailOptions).catch(emailError => {
        console.error("📧 Email error (non-critical):", emailError.message);
      });
      
      // ========== إعادة التوجيه مع رسالة نجاح ==========
      req.session.save((err) => {
        if (err) console.error("Session save error:", err);
        console.log("✅ Upload completed successfully! Redirecting to /admin");
        res.send(`
          <script>
            alert('✅ تم رفع النتيجة بنجاح للمريض: ${name}\\n📧 تم إرسال إشعار إلى البريد الإلكتروني.');
            window.location.href = '/admin';
          </script>
        `);
      });
      
    } catch (error) {
      console.error("💥 Upload error details:", error);
      res.status(500).send(`
        <script>
          alert('❌ حدث خطأ أثناء رفع الملف: ${error.message.replace(/'/g, "\\'")}\\n\\nيرجى المحاولة مرة أخرى أو التحقق من الملف.');
          window.location.href = '/admin';
        </script>
      `);
    }
  }
);

// Delete route
app.post("/admin/delete", async (req, res) => {
  try {

    if (!req.session.loggedIn) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized"
      });
    }

    const id = req.body.file;

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "Missing ID"
      });
    }

    const doc = await db.collection("results").doc(id).get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: "Result not found"
      });
    }

    const result = doc.data();

    // حذف الملف من Cloudinary
    if (result?.public_id) {

      const resourceType =
        result.resource_type === "image"
          ? "image"
          : "raw";

      await cloudinary.uploader.destroy(result.public_id, {
        resource_type: resourceType,
      });

      console.log("✅ File deleted from Cloudinary");
    }

    // حذف من Firestore
    await deleteResult(id);

    console.log("✅ Result deleted:", id);

    // إرسال إشعار بريد
    if (result.email) {

      try {

        await transporter.sendMail({
          from: process.env.EMAIL_ADDRESS,
          to: result.email,
          subject: "تم حذف نتيجة التحليل",
          html: `
            <div dir="rtl" style="font-family:Tahoma">
              <h2>مرحباً ${result.name}</h2>
              <p>تم حذف نتيجة التحليل الخاصة بك من النظام.</p>
              <p><strong>نوع التحليل:</strong> ${result.test}</p>
            </div>
          `
        });

        console.log("📧 Delete notification sent");

      } catch(emailErr) {
        console.error("Email error:", emailErr);
      }
    }

    return res.json({
      success: true
    });

  } catch (error) {

    console.error("Delete error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// مسار عرض وتحميل الملفات (التصحيح النهائي)
// مسار عرض وتحميل الملفات (حل شامل للمشكلة)
app.get("/view/:id", async (req, res) => {

  try {

    const doc = await db.collection("results").doc(req.params.id).get();

    if (!doc.exists) {
      return res.status(404).send("الملف غير موجود");
    }

    const data = doc.data();

    if (!data.file) {
      return res.status(404).send("لا يوجد ملف");
    }

    const fileUrl = data.file;

    // تحميل
    if (req.query.download === 'true') {

      const filename =
        data.original_filename || "result.pdf";

      const downloadUrl =
        fileUrl +
        (fileUrl.includes("?") ? "&" : "?") +
        `fl_attachment:${encodeURIComponent(filename)}`;

      return res.redirect(downloadUrl);
    }

    // عرض مباشر
    return res.redirect(fileUrl);

  } catch (error) {

    console.error(error);

    res.status(500).send("حدث خطأ أثناء عرض الملف");
  }
});

module.exports = app;
