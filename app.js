const express = require("express");
const session = require("express-session");
const multer = require("multer");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

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

// تحميل و حفظ النتائج
function loadResults() {
  if (!fs.existsSync("results.json")) fs.writeFileSync("results.json", "[]");
  const raw = fs.readFileSync("results.json", "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
function saveResults(results) {
  fs.writeFileSync("results.json", JSON.stringify(results, null, 2));
}

// إعداد البريد
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_ADDRESS || "yourlabemail@gmail.com",
    pass: process.env.EMAIL_PASSWORD || "your_app_password",
  },
});

// صفحات العملاء
app.get("/", (req, res) => {
  res.render("index");
});

app.post("/result", (req, res) => {
  const phone = req.body.phone;
  const results = loadResults();
  const result = results.filter(r => r.phone === phone);
  if (result.length > 0) {
    res.render("result", { result });
  } else {
    res.send("لم يتم العثور على نتيجة لهذا الرقم.");
  }
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
app.get("/admin", (req, res) => {
  if (req.session.loggedIn) {
    const results = loadResults();
    res.render("admin/dashboard", { results });
  } else {
    res.render("admin/login");
  }
});

app.post("/admin/login", (req, res) => {
  const { username, password } = req.body;
  if (
    username === (process.env.ADMIN_USERNAME || "admin") &&
    password === (process.env.ADMIN_PASSWORD || "123456")
  ) {
    req.session.loggedIn = true;
    res.redirect("/admin");
  } else {
    res.send("بيانات الدخول غير صحيحة.");
  }
});

app.post("/admin/upload", upload.single("pdf"), (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/admin");

  const { name, phone, email } = req.body;
  const file = req.file.filename;

  const newResult = {
    name,
    phone,
    email,
    file,
    date: new Date().toLocaleString("ar-EG", { timeZone: "Africa/Cairo" })
  };

  const results = loadResults();
  results.push(newResult);
  saveResults(results);

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

app.post("/admin/delete", (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/admin");

  const fileToDelete = req.body.file;
  const results = loadResults().filter(r => r.file !== fileToDelete);
  saveResults(results);

  const filePath = path.join(__dirname, "uploads", fileToDelete);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

  res.redirect("/admin");
});

app.post("/admin/notify", (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/admin");

  const fileToNotify = req.body.file;
  const result = loadResults().find(r => r.file === fileToNotify);
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
