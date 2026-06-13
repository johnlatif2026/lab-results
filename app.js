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

// ✅ تحديد مسار views
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
    maxAge: 8 * 60 * 60 * 1000, // 8 ساعات
    httpOnly: true,
    sameSite: 'lax'
  },
  unset: 'keep'
}));

// ✅ Middleware لتجديد الجلسة تلقائياً (يمنع انتهائها)
app.use((req, res, next) => {
  if (req.session && req.session.loggedIn) {
    // تجديد الجلسة لكل request نشط
    req.session.touch();
    
    // إضافة متغير محلي للتحقق من حالة الدخول في الـ views
    res.locals.isAdmin = true;
  } else {
    res.locals.isAdmin = false;
  }
  next();
});

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
  console.log("🔐 Admin route accessed - Session ID:", req.session?.id, "LoggedIn:", req.session?.loggedIn);
  
  if (req.session && req.session.loggedIn) {
    try {
      const results = await loadResults();
      console.log(`✅ Loaded ${results.length} results`);
      
      // لا نمرر successMessage من query string لأننا سنستخدم localStorage
      res.render("admin/dashboard", { 
        results,
        successMessage: null  // إلغاء استخدام query string
      });
    } catch (error) {
      console.error("Error loading dashboard:", error);
      res.status(500).send("Error loading dashboard: " + error.message);
    }
  } else {
    console.log("🔐 Not logged in, showing login page");
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

// ✅ UPLOAD ROUTE - النسخة النهائية المستقرة
app.post("/admin/upload", 
  // 1. التحقق من الجلسة أولاً
  async (req, res, next) => {
    console.log("🔐 [1] Session check - ID:", req.session.id, "LoggedIn:", req.session.loggedIn);
    
    // تحديث الجلسة لتجديد وقتها
    req.session.touch();
    
    if (!req.session.loggedIn) {
      console.log("❌ Not logged in, redirecting to login");
      return res.redirect("/admin");
    }
    next();
  },
  
  // 2. معالجة الملف (استخدام multer memory storage)
  multerMemory.single("pdf"),
  
  // 3. معالجة البيانات
  async (req, res) => {
    console.log("📁 [2] Processing upload, Session ID:", req.session.id);
    
    // التحقق من الجلسة مرة أخرى بعد multer
    if (!req.session || !req.session.loggedIn) {
      console.log("❌ [3] Session lost! Redirecting to login");
      return res.redirect("/admin?error=session_expired");
    }

    try {
      // تحديث الجلسة قبل أي عملية
      req.session.touch();
      
      // التحقق من وجود ملف
      if (!req.file) {
        console.log("❌ No file uploaded");
        return res.redirect("/admin?error=no_file");
      }

      console.log(`📄 File: ${req.file.originalname}, Size: ${req.file.size}`);

      // استخراج البيانات
      const { name, phone, email, test, notes } = req.body;
      
      if (!name || !phone || !email || !test) {
        return res.redirect("/admin?error=missing_fields");
      }

      // التحقق من رقم الهاتف
      if (!/^[0-9]{10,11}$/.test(phone.replace(/\D/g, ''))) {
        return res.redirect("/admin?error=invalid_phone");
      }

      // ========== رفع الملف إلى Cloudinary ==========
      console.log("☁️ Uploading to Cloudinary...");
      
      const fileExtension = req.file.originalname.split('.').pop().toLowerCase();
      const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'].includes(fileExtension);
      const isPdf = fileExtension === 'pdf';
      
      let resourceType = 'auto';
      if (isImage) resourceType = 'image';
      if (isPdf) resourceType = 'raw';
      
      let baseName = req.file.originalname.replace(/\.[^/.]+$/, '');
      baseName = baseName.replace(/[^a-zA-Z0-9\u0600-\u06FF\-_]/g, '_');
      const publicId = `${Date.now()}-${baseName}`;
      
      const uploadResult = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            folder: "lab-results",
            resource_type: resourceType,
            access_mode: "public",
            public_id: publicId,
            ...(resourceType === 'raw' && { allowed_formats: ['pdf', 'doc', 'docx'] })
          },
          (error, result) => {
            if (error) {
              console.error("❌ Cloudinary error:", error);
              reject(error);
            } else {
              console.log("✅ Cloudinary success:", result.secure_url);
              resolve(result);
            }
          }
        );
        uploadStream.end(req.file.buffer);
      });
      
      // ========== حفظ في Firestore ==========
      const cleanId = Date.now().toString();
      
      const newResult = {
        name: name.trim(),
        test: test.trim(),
        phone: phone.trim(),
        email: email.trim().toLowerCase(),
        notes: notes || "",
        file: uploadResult.secure_url,
        public_id: uploadResult.public_id,
        original_filename: req.file.originalname,
        file_size: req.file.size,
        mime_type: req.file.mimetype,
        resource_type: uploadResult.resource_type,
        date: new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })
      };
      
      await addResult(cleanId, newResult);
      console.log(`✅ Saved to Firestore: ${cleanId}`);
      
      // ========== إرسال البريد ==========
      const protocol = req.protocol === 'https' ? 'https' : 'http';
      const host = req.get('host');
      const link = `${protocol}://${host}/view/${cleanId}`;
      
      transporter.sendMail({
        from: process.env.EMAIL_ADDRESS,
        to: email,
        subject: `نتيجة التحليل - ${test}`,
        html: `
          <div dir="rtl" style="font-family: Tahoma; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
            <h2 style="color: #6a11cb;">مرحباً ${name}</h2>
            <p>تم إضافة نتيجة التحليل الخاصة بك.</p>
            <p><strong>نوع التحليل:</strong> ${test}</p>
            <p style="text-align: center;">
              <a href="${link}" style="display: inline-block; background: #6a11cb; color: white; padding: 12px 25px; text-decoration: none; border-radius: 8px;">📄 عرض النتيجة</a>
            </p>
            ${notes ? `<p><strong>📝 ملاحظات:</strong> ${notes}</p>` : ''}
            <hr>
            <p style="color: #666; font-size: 12px;">مع تحيات مركز التحاليل الطبية</p>
          </div>
        `
      }).catch(err => console.error("📧 Email error:", err.message));
      
      // ========== إعادة التوجيه مع الحفاظ على الجلسة ==========
      console.log("✅ Upload complete! Redirecting to /admin");
      
      // استخدام save للتأكد من بقاء الجلسة
      req.session.save((err) => {
        if (err) console.error("Session save error:", err);
        
        // استخدام JavaScript redirect مع localStorage
        res.send(`
          <!DOCTYPE html>
          <html>
          <head>
            <script>
              // تخزين رسالة النجاح في localStorage
              localStorage.setItem('uploadSuccess', 'تم رفع النتيجة بنجاح للمريض: ${name.replace(/'/g, "\\'")}');
              // التوجيه إلى /admin
              window.location.href = '/admin';
            </script>
          </head>
          <body>جاري التوجيه...</body>
          </html>
        `);
      });
      
    } catch (error) {
      console.error("💥 Upload error:", error);
      res.redirect("/admin?error=" + encodeURIComponent(error.message));
    }
  }
);

// Delete route - نسخة محسنة
app.post("/admin/delete", async (req, res) => {
  console.log("🗑️ Delete request received");
  console.log("Request body:", req.body);
  
  try {
    if (!req.session.loggedIn) {
      console.log("❌ Unauthorized");
      return res.status(401).json({
        success: false,
        message: "غير مصرح بهذا الإجراء"
      });
    }

    const id = req.body.file;
    console.log(`File ID to delete: ${id}`);

    if (!id) {
      return res.status(400).json({
        success: false,
        message: "لم يتم إرسال معرف الملف"
      });
    }

    const doc = await db.collection("results").doc(id).get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        message: "النتيجة غير موجودة"
      });
    }

    const result = doc.data();
    console.log(`Patient: ${result.name}`);

    // حذف الملف من Cloudinary
    if (result.public_id) {
      try {
        const resourceType = result.resource_type === "image" ? "image" : "raw";
        console.log(`☁️ Deleting from Cloudinary: ${result.public_id}`);
        
        await cloudinary.uploader.destroy(result.public_id, {
          resource_type: resourceType,
        });
        console.log("✅ File deleted from Cloudinary");
      } catch (cloudinaryError) {
        console.error("❌ Cloudinary error:", cloudinaryError.message);
      }
    }

    // حذف من Firestore
    await db.collection("results").doc(id).delete();
    console.log("✅ Result deleted from Firestore");

    // إرسال إشعار بريد
    if (result.email) {
      transporter.sendMail({
        from: process.env.EMAIL_ADDRESS,
        to: result.email,
        subject: "تم حذف نتيجة التحليل",
        html: `
          <div dir="rtl" style="font-family: Tahoma, sans-serif; padding: 20px;">
            <h2 style="color: #dc2626;">مرحباً ${result.name}</h2>
            <p>تم حذف نتيجة التحليل الخاصة بك من النظام.</p>
            <p><strong>نوع التحليل:</strong> ${result.test}</p>
            <hr>
            <p style="color: #666; font-size: 12px;">هذا إشعار آلي</p>
          </div>
        `
      }).catch(emailErr => console.error("❌ Email error:", emailErr.message));
    }

    return res.status(200).json({
      success: true,
      message: "تم حذف النتيجة بنجاح"
    });

  } catch (error) {
    console.error("💥 Delete error:", error);
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// مسار عرض وتحميل الملفات
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
    const isDownload = req.query.download === 'true';
    
    let filename = data.original_filename || "result.pdf";
    if (!filename.match(/\.(pdf|jpg|jpeg|png|doc|docx)$/i)) {
      filename += '.pdf';
    }

    const response = await axios({
      method: 'get',
      url: fileUrl,
      responseType: 'stream',
      headers: {
        'User-Agent': 'Mozilla/5.0'
      }
    });

    let contentType = 'application/octet-stream';
    const fileExtension = filename.split('.').pop().toLowerCase();
    
    switch (fileExtension) {
      case 'pdf':
        contentType = 'application/pdf';
        break;
      case 'jpg':
      case 'jpeg':
        contentType = 'image/jpeg';
        break;
      case 'png':
        contentType = 'image/png';
        break;
      case 'doc':
        contentType = 'application/msword';
        break;
      case 'docx':
        contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        break;
    }

    if (isDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    }
    
    res.setHeader('Content-Type', contentType);
    response.data.pipe(res);

  } catch (error) {
    console.error("❌ Error in /view/:id:", error.message);
    if (error.response && error.response.status === 404) {
      return res.status(404).send("الملف غير موجود على الخادم");
    }
    res.status(500).send("حدث خطأ أثناء معالجة الملف: " + error.message);
  }
});

module.exports = app;
