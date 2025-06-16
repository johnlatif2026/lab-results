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

// إعداد التخزين للملفات
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage });

// إعدادات EJS والملفات الثابتة
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: "secret-key",
  resave: false,
  saveUninitialized: true,
}));

// تحميل البيانات من JSON
function loadResults() {
  if (!fs.existsSync("results.json")) fs.writeFileSync("results.json", "[]");
  const raw = fs.readFileSync("results.json", "utf-8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error("❌ ملف النتائج غير صالح JSON. سيتم تفريغه.");
    return [];
  }
}

function saveResults(results) {
  fs.writeFileSync("results.json", JSON.stringify(results, null, 2));
}

// إعداد البريد الإلكتروني (Gmail)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_ADDRESS || "yourlabemail@gmail.com",
    pass: process.env.EMAIL_PASSWORD || "your_app_password",
  },
});

// ✅ الصفحات العامة

app.get("/", (req, res) => {
  res.render("index");
});

app.post("/result", (req, res) => {
  const phone = req.body.phone;
  const results = loadResults();
  const result = results.find(r => r.phone === phone);
  if (result) {
    res.render("result", { result });
  } else {
    res.send("لم يتم العثور على نتيجة لهذا الرقم.");
  }
});

app.get("/download/:filename", (req, res) => {
  const file = path.join(__dirname, "uploads", req.params.filename);
  res.download(file);
});

// ✅ إدارة المسؤول

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
  const validUser = process.env.ADMIN_USERNAME || "admin";
  const validPass = process.env.ADMIN_PASSWORD || "123456";

  if (username === validUser && password === validPass) {
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
    date: new Date().toISOString(),
  };

  const results = loadResults();
  results.push(newResult);
  saveResults(results);

  // إرسال إشعار عبر الإيميل
  const mailOptions = {
    from: process.env.EMAIL_ADDRESS || "yourlabemail@gmail.com",
    to: email,
    subject: "نتيجة التحاليل الخاصة بك",
    text: `مرحبًا ${name}، نتيجتك أصبحت جاهزة. يمكنك تحميلها من الموقع باستخدام رقم هاتفك.`,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log("فشل في إرسال الإيميل:", error);
    } else {
      console.log("تم إرسال الإيميل:", info.response);
    }
  });

  res.redirect("/admin");
});

app.listen(PORT, () => {
  console.log(`✅ السيرفر شغال على http://localhost:${PORT}`);
});
