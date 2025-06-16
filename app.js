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

// إعداد EJS وملفات ثابتة
app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: "secret-key",
  resave: false,
  saveUninitialized: true,
}));

// تحميل وحفظ النتائج
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

// تحميل وإدارة إشعارات الحذف
function loadNotified() {
  if (!fs.existsSync("notifications.json")) fs.writeFileSync("notifications.json", "[]");
  return JSON.parse(fs.readFileSync("notifications.json", "utf-8"));
}

function saveNotified(data) {
  fs.writeFileSync("notifications.json", JSON.stringify(data, null, 2));
}

// إعداد البريد
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_ADDRESS,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// ✅ صفحات عامة
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

app.get("/view/:filename", (req, res) => {
  const file = path.join(__dirname, "uploads", req.params.filename);
  res.sendFile(file);
});

// ✅ إدارة المسؤول
app.get("/admin", (req, res) => {
  if (req.session.loggedIn) {
    const results = loadResults();
    const notified = loadNotified();
    res.render("admin/dashboard", { results, notified });
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

  const mailOptions = {
    from: process.env.EMAIL_ADDRESS,
    to: email,
    subject: "نتيجة التحاليل الخاصة بك",
    text: `مرحبًا ${name}، نتيجة التحليل أصبحت جاهزة. يمكنك تحميلها من الموقع باستخدام رقم هاتفك. الذي سجلت به في المعمل`,
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

app.post("/admin/delete", (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/admin");

  const phone = req.body.phone;
  let results = loadResults();
  results = results.filter(r => r.phone !== phone);
  saveResults(results);

  res.redirect("/admin");
});

app.post("/admin/notify-delete", (req, res) => {
  if (!req.session.loggedIn) return res.redirect("/admin");

  const phone = req.body.phone;
  const results = loadResults();
  const notified = loadNotified();
  const alreadyNotified = notified.find(n => n.phone === phone);
  const result = results.find(r => r.phone === phone);

  if (result && !alreadyNotified) {
    const mailOptions = {
      from: process.env.EMAIL_ADDRESS,
      to: result.email,
      subject: "تنبيه بحذف نتيجة التحاليل",
      text: `مرحبًا ${result.name}، تم حذف نتيجة التحاليل الخاصة بك من النظام.`,
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error("❌ فشل إرسال إشعار الحذف:", error);
      } else {
        console.log("✅ تم إرسال إشعار الحذف:", info.response);
        notified.push({ phone, sentAt: new Date().toISOString() });
        saveNotified(notified);
      }
    });
  }

  res.redirect("/admin");
});

app.listen(PORT, () => {
  console.log(`✅ السيرفر شغال على http://localhost:${PORT}`);
});
