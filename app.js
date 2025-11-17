const express = require("express");
const session = require("express-session");
const multer = require("multer");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const admin = require("firebase-admin");

const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);

// تهيئة Firebase
admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
});
const db = admin.firestore();

const app = express();
const PORT = process.env.PORT || 3000;

// إعدادات رفع الملفات
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "uploads/"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname),
});
const upload = multer({ storage });

// إعدادات التطبيق
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: "secret-key",
  resave: false,
  saveUninitialized: true,
}));

// 🔥 دوال Firestore
async function loadResults() {
  const snapshot = await db.collection("results").get();
  return snapshot.docs.map(doc => doc.data());
}

async function addResult(result) {
  await db.collection("results").doc(result.file).set(result);
}

async function deleteResult(file) {
  await db.collection("results").doc(file).delete();
}

async function findResultsByPhone(phone) {
  const snapshot = await db.collection("results").where("phone", "==", phone).get();
  return snapshot.docs.map(doc => doc.data());
}

// إعداد البريد
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_ADDRESS,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// صفحات العملاء
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

app.get("/download/:filename", (req, res) => {
  const file = path.join(__dirname, "uploads", req.params.filename);
  res.download(file);
});

app.get("/view/:filename", (req, res) => {
  const file = path.join(__dirname, "uploads", req.params.filename);
  res.sendFile(file);
});

// لوحة التحكم
app.get("/admin", async (req, res) => {
  if (req.session.loggedIn) {
    const results = await loadResults();
    res.render("admin/dashboard", { results });
  } else {
    res.render("admin/login");
  }
});

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (
    username === (process.env.ADMIN_USERNAME || "john") &&
    password === (process.env.ADMIN_PASSWORD || "latif")
  ) {
    req.session.loggedIn = true;
    res.redirect("/admin");
  } else {
    res.send("بيانات الدخول غير صحيحة.");
  }
});

// ✅ تسجيل الخروج
app.get("/admin/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.send("حدث خطأ أثناء تسجيل الخروج.");
    }
    res.redirect("/admin");
  });
});

app.post("/admin/upload", upload.single("pdf"), async (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/admin");

  const { name, phone, email, test } = req.body;
  const file = req.file.filename;

  const newResult = {
    name,            // اسم المريض
    test,            // اسم التحليل
    phone,           // رقم الهاتف
    email,
    file,
    date: new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })
  };

  await addResult(newResult);

  const link = `http://lab-results-production.up.railway.app/`;

  const mailOptions = {
    from: process.env.EMAIL_ADDRESS,
    to: email,
    subject: "نتيجة التحاليل الخاصة بك",
    text: `مرحبًا ${name}،\n\nنتيجة التحليل الخاصة بك أصبحت جاهزة.\n\nيمكنك زيارة الموقع والبحث باستخدام رقم هاتفك:\n${link}\n\n.`,
  };

  transporter.sendMail(mailOptions, (error) => {
    if (error) console.log("❌ فشل إرسال الإيميل:", error);
    res.redirect("/admin");
  });
});

app.post("/admin/delete", async (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/admin");

  const fileToDelete = req.body.file;
  await deleteResult(fileToDelete);

  const filePath = path.join(__dirname, "uploads", fileToDelete);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  res.redirect("/admin");
});

app.post("/admin/notify", async (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/admin");

  const fileToNotify = req.body.file;
  const snapshot = await db.collection("results").doc(fileToNotify).get();
  const result = snapshot.data();

  if (!result) return res.send("التحليل غير موجود.");

  const mailOptions = {
    from: process.env.EMAIL_ADDRESS,
    to: result.email,
    subject: "تم حذف نتيجتك من الموقع",
    text: `مرحبًا ${result.name}، لقد تم حذف نتيجتك من النظام. لأي استفسار يرجى التواصل مع https://wa.me/+201274445091.`,
  };

  transporter.sendMail(mailOptions, (error) => {
    if (error) console.log("❌ فشل إرسال الإيميل:", error);
    res.redirect("/admin");
  });
});

app.listen(PORT, () => {
  console.log(`✅ السيرفر شغال على http://localhost:${PORT}`);
});
