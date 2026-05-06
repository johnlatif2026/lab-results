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

// ✅ استخدام HTML بدلاً من EJS مؤقتاً
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Session
const MemoryStore = require('memorystore')(session);

app.use(session({
  secret: process.env.SESSION_SECRET || "secret-key",
  resave: false,
  saveUninitialized: false,
  store: new MemoryStore({
    checkPeriod: 86400000
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
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

// ============ Routes ============

// ✅ صفحة Login (HTML مباشر)
app.get("/admin", (req, res) => {
  if (req.session.loggedIn) {
    res.redirect("/dashboard");
  } else {
    res.send(`
      <!DOCTYPE html>
      <html dir="rtl">
      <head>
        <meta charset="UTF-8">
        <title>تسجيل الدخول</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
          }
          .login-container {
            background: white;
            padding: 40px;
            border-radius: 10px;
            box-shadow: 0 0 20px rgba(0,0,0,0.2);
            width: 300px;
          }
          h2 {
            text-align: center;
            color: #333;
          }
          input {
            width: 100%;
            padding: 10px;
            margin: 10px 0;
            border: 1px solid #ddd;
            border-radius: 5px;
          }
          button {
            width: 100%;
            padding: 10px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
          }
          button:hover {
            background: #764ba2;
          }
        </style>
      </head>
      <body>
        <div class="login-container">
          <h2>تسجيل الدخول</h2>
          <form action="/admin/login" method="POST">
            <input type="text" name="username" placeholder="اسم المستخدم" required>
            <input type="password" name="password" placeholder="كلمة المرور" required>
            <button type="submit">دخول</button>
          </form>
        </div>
      </body>
      </html>
    `);
  }
});

// ✅ معالجة تسجيل الدخول
app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (
    username === (process.env.ADMIN_USERNAME || "john") &&
    password === (process.env.ADMIN_PASSWORD || "latif")
  ) {
    req.session.loggedIn = true;
    res.redirect("/dashboard");
  } else {
    res.send("بيانات الدخول غير صحيحة.");
  }
});

// ✅ Dashboard (HTML مباشر)
app.get("/dashboard", async (req, res) => {
  if (!req.session.loggedIn) {
    return res.redirect("/admin");
  }
  
  const results = await loadResults();
  
  let resultsHTML = '';
  results.forEach(result => {
    resultsHTML += `
      <tr>
        <td>${result.name || ''}</td>
        <td>${result.test || ''}</td>
        <td>${result.phone || ''}</td>
        <td>${result.email || ''}</td>
        <td><a href="${result.file}" target="_blank">عرض</a></td>
        <td>${result.date || ''}</td>
        <td>
          <form action="/admin/delete" method="POST" style="display:inline;">
            <input type="hidden" name="file" value="${result.id}">
            <button type="submit" style="background:red;color:white;border:none;padding:5px 10px;cursor:pointer;">حذف</button>
          </form>
        </td>
      </tr>
    `;
  });
  
  res.send(`
    <!DOCTYPE html>
    <html dir="rtl">
    <head>
      <meta charset="UTF-8">
      <title>لوحة التحكم</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #f4f4f4;
          margin: 0;
          padding: 20px;
        }
        .container {
          max-width: 1200px;
          margin: auto;
          background: white;
          padding: 20px;
          border-radius: 10px;
        }
        h1 {
          color: #333;
        }
        form {
          background: #f9f9f9;
          padding: 20px;
          border-radius: 10px;
          margin-bottom: 20px;
        }
        input, select, textarea {
          width: 100%;
          padding: 8px;
          margin: 5px 0 15px 0;
          border: 1px solid #ddd;
          border-radius: 5px;
        }
        button {
          background: #667eea;
          color: white;
          padding: 10px 20px;
          border: none;
          border-radius: 5px;
          cursor: pointer;
        }
        table {
          width: 100%;
          border-collapse: collapse;
        }
        th, td {
          border: 1px solid #ddd;
          padding: 10px;
          text-align: right;
        }
        th {
          background: #667eea;
          color: white;
        }
        .logout {
          float: left;
          background: red;
          margin-bottom: 20px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <a href="/admin/logout"><button class="logout">تسجيل خروج</button></a>
        <h1>لوحة التحكم - إضافة نتيجة جديدة</h1>
        
        <form action="/admin/upload" method="POST" enctype="multipart/form-data">
          <label>الاسم:</label>
          <input type="text" name="name" required>
          
          <label>نوع التحليل:</label>
          <input type="text" name="test" required>
          
          <label>رقم الهاتف:</label>
          <input type="text" name="phone" required>
          
          <label>البريد الإلكتروني:</label>
          <input type="email" name="email" required>
          
          <label>ملاحظات:</label>
          <textarea name="notes" rows="3"></textarea>
          
          <label>الملف (PDF):</label>
          <input type="file" name="pdf" accept=".pdf" required>
          
          <button type="submit">رفع وإرسال</button>
        </form>
        
        <h2>النتائج المضافة</h2>
        <table>
          <thead>
            <tr><th>الاسم</th><th>التحليل</th><th>الهاتف</th><th>البريد</th><th>الملف</th><th>التاريخ</th><th>إجراء</th></tr>
          </thead>
          <tbody>
            ${resultsHTML}
          </tbody>
        </table>
      </div>
    </body>
    </html>
  `);
});

// ✅ تسجيل الخروج
app.get("/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/admin");
  });
});

// ✅ الصفحة الرئيسية للمستخدمين
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html dir="rtl">
    <head>
      <meta charset="UTF-8">
      <title>الاستعلام عن النتائج</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          display: flex;
          justify-content: center;
          align-items: center;
          height: 100vh;
          margin: 0;
        }
        .container {
          background: white;
          padding: 40px;
          border-radius: 10px;
          box-shadow: 0 0 20px rgba(0,0,0,0.2);
          width: 350px;
          text-align: center;
        }
        h1 {
          color: #333;
        }
        input {
          width: 100%;
          padding: 12px;
          margin: 20px 0;
          border: 1px solid #ddd;
          border-radius: 5px;
          font-size: 16px;
        }
        button {
          width: 100%;
          padding: 12px;
          background: #667eea;
          color: white;
          border: none;
          border-radius: 5px;
          font-size: 16px;
          cursor: pointer;
        }
        button:hover {
          background: #764ba2;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📋 الاستعلام عن النتائج</h1>
        <form action="/result" method="POST">
          <input type="text" name="phone" placeholder="أدخل رقم الهاتف" required>
          <button type="submit">بحث</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

// ✅ عرض النتائج
app.post("/result", async (req, res) => {
  const phone = req.body.phone;
  const results = await findResultsByPhone(phone);
  
  if (results.length === 0) {
    return res.send(`
      <!DOCTYPE html>
      <html dir="rtl">
      <head><meta charset="UTF-8"><title>لا توجد نتائج</title></head>
      <body style="font-family:Arial;text-align:center;padding:50px;">
        <h2>⚠️ لا توجد نتائج لهذا الرقم</h2>
        <a href="/">الرجوع للصفحة الرئيسية</a>
      </body>
      </html>
    `);
  }
  
  let resultsHTML = '';
  results.forEach(result => {
    resultsHTML += `
      <div style="border:1px solid #ddd;padding:15px;margin:10px;border-radius:5px;">
        <h3>${result.name || 'بدون اسم'}</h3>
        <p><strong>نوع التحليل:</strong> ${result.test || ''}</p>
        <p><strong>الملاحظات:</strong> ${result.notes || 'لا توجد'}</p>
        <a href="${result.file}" target="_blank" style="background:#667eea;color:white;padding:10px;text-decoration:none;border-radius:5px;">📄 عرض النتيجة</a>
      </div>
    `;
  });
  
  res.send(`
    <!DOCTYPE html>
    <html dir="rtl">
    <head>
      <meta charset="UTF-8">
      <title>النتائج</title>
      <style>
        body { font-family: Arial; padding: 20px; background: #f4f4f4; }
        .container { max-width: 600px; margin: auto; }
        h1 { text-align: center; color: #333; }
        .result { background: white; border-radius: 10px; margin-bottom: 20px; }
        .back { text-align: center; margin-top: 20px; }
        .back a { color: #667eea; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>📄 نتائج البحث لرقم: ${phone}</h1>
        ${resultsHTML}
        <div class="back"><a href="/">← الرجوع للبحث</a></div>
      </div>
    </body>
    </html>
  `);
});

// ✅ عرض الملف
app.get("/view/:id", async (req, res) => {
  const doc = await db.collection("results").doc(req.params.id).get();
  const data = doc.data();
  if (!data) return res.send("Not found");
  res.redirect(data.file);
});

// ✅ رفع الملفات
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
    res.redirect("/dashboard");
  });
});

// ✅ حذف
app.post("/admin/delete", async (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/admin");

  const id = req.body.file;
  const doc = await db.collection("results").doc(id).get();
  const result = doc.data();

  if (result?.public_id) {
    await cloudinary.uploader.destroy(result.public_id, { resource_type: "raw" });
  }

  await deleteResult(id);
  res.redirect("/dashboard");
});

module.exports = app;
