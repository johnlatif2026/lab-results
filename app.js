const axios = require('axios');
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const path = require("path");
require("dotenv").config();

const admin = require("firebase-admin");

// ========== Firebase ==========
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

// ========== View Engine ==========
const viewsPath = path.join(__dirname, "views");
app.set("views", viewsPath);
app.set("view engine", "ejs");

// ========== Middleware ==========
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Session configuration (المعدل)
const MemoryStore = require('memorystore')(session);
app.use(session({
  secret: process.env.SESSION_SECRET || "secret-key",
  resave: false,        // ✅ changed from true to false
  saveUninitialized: false,  // ✅ changed from true to false
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000,  // ✅ 24 ساعة بدل 8
    httpOnly: true,
    sameSite: 'lax'
  }
}));

// Force session cookie middleware
app.use((req, res, next) => {
  if (req.session && req.session.loggedIn && !req.cookies?.token) {
    req.session.touch();
  }
  next();
});

// Session refresh middleware
app.use((req, res, next) => {
  if (req.session && req.session.loggedIn) {
    req.session.touch();
    res.locals.isAdmin = true;
  } else {
    res.locals.isAdmin = false;
  }
  next();
});

// ========== Cloudinary Config ==========
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const multerMemory = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

// ========== Email Transporter ==========
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_ADDRESS,
    pass: process.env.EMAIL_PASSWORD,
  },
});

// ========== Telegram Functions ==========
async function sendTelegramMessage(chatId, text) {
  const token = process.env.BOT_TOKEN;
  if (!token) throw new Error("Missing BOT_TOKEN env var");

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  if (!resp.ok) {
    const t = await resp.text();
    throw new Error("Telegram sendMessage failed: " + t);
  }
  return resp.json();
}

function normalizePhone(input) {
  return String(input || "").replace(/[^\d]/g, "");
}

// ========== Firestore Functions ==========
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
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

// ========== Routes ==========
app.get("/", (req, res) => {
  res.render("index");
});

app.get('/privacy', (req, res) => {
  res.render('privacy');
});

app.post("/result", async (req, res) => {
  const phone = req.body.phone;
  const filteredResults = await findResultsByPhone(phone);
  res.render("result", {
    result: filteredResults,
    phoneNumber: phone
  });
});

// ========== Admin Routes ==========
app.get("/admin", async (req, res) => {
  if (req.session && req.session.loggedIn) {
    try {
      const results = await loadResults();
      const numbersSnapshot = await db.collection("bot_numbers").orderBy("createdAt", "desc").limit(100).get();
      const telegramNumbers = numbersSnapshot.docs.map(doc => doc.data());
      
      res.render("admin/dashboard", { 
        results,
        telegramNumbers,
        successMessage: null
      });
    } catch (error) {
      console.error("Error loading dashboard:", error);
      res.status(500).send("Error loading dashboard: " + error.message);
    }
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
    req.session.save((err) => {
      res.redirect("/admin");
    });
  } else {
    res.send("بيانات الدخول غير صحيحة.");
  }
});

app.get("/admin/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/admin");
  });
});

// ========== Upload Route ==========
app.post("/admin/upload", 
  async (req, res, next) => {
    if (!req.session.loggedIn) {
      return res.redirect("/admin");
    }
    req.session.touch();
    next();
  },
  multerMemory.single("pdf"),
  async (req, res) => {
    if (!req.session || !req.session.loggedIn) {
      return res.redirect("/admin?error=session_expired");
    }

    try {
      if (!req.file) {
        return res.redirect("/admin?error=no_file");
      }

      const { name, phone, email, test, notes } = req.body;
      if (!name || !phone || !email || !test) {
        return res.redirect("/admin?error=missing_fields");
      }

      if (!/^[0-9]{10,11}$/.test(phone.replace(/\D/g, ''))) {
        return res.redirect("/admin?error=invalid_phone");
      }

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
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(req.file.buffer);
      });
      
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
      
      const protocol = req.protocol === 'https' ? 'https' : 'http';
      const host = req.get('host');
      const link = `${protocol}://${host}/view/${cleanId}`;
      
      transporter.sendMail({
        from: process.env.EMAIL_ADDRESS,
        to: email,
        subject: `نتيجة التحليل - ${test}`,
        html: `<div dir="rtl"><h2>مرحباً ${name}</h2><p>تم إضافة نتيجة التحليل الخاصة بك.</p><a href="${link}">عرض النتيجة</a></div>`
      }).catch(err => console.error("Email error:", err.message));
      
      req.session.save((err) => {
        res.send(`
          <script>
            localStorage.setItem('uploadSuccess', 'تم رفع النتيجة بنجاح للمريض: ${name.replace(/'/g, "\\'")}');
            window.location.href = '/admin';
          </script>
        `);
      });
      
    } catch (error) {
      console.error("Upload error:", error);
      res.redirect("/admin?error=" + encodeURIComponent(error.message));
    }
  }
);

// ========== Delete Route ==========
app.post("/admin/delete", async (req, res) => {
  try {
    if (!req.session.loggedIn) {
      return res.status(401).json({ success: false, message: "غير مصرح" });
    }

    const id = req.body.file;
    if (!id) {
      return res.status(400).json({ success: false, message: "لم يتم إرسال معرف الملف" });
    }

    const doc = await db.collection("results").doc(id).get();
    if (!doc.exists) {
      return res.status(404).json({ success: false, message: "النتيجة غير موجودة" });
    }

    const result = doc.data();
    if (result.public_id) {
      try {
        const resourceType = result.resource_type === "image" ? "image" : "raw";
        await cloudinary.uploader.destroy(result.public_id, { resource_type: resourceType });
      } catch (cloudinaryError) {
        console.error("Cloudinary error:", cloudinaryError.message);
      }
    }

    await db.collection("results").doc(id).delete();

    if (result.email) {
      transporter.sendMail({
        from: process.env.EMAIL_ADDRESS,
        to: result.email,
        subject: "تم حذف نتيجة التحليل",
        html: `<div dir="rtl"><h2>مرحباً ${result.name}</h2><p>تم حذف نتيجة التحليل الخاصة بك من النظام.</p></div>`
      }).catch(err => console.error("Email error:", err.message));
    }

    return res.status(200).json({ success: true, message: "تم حذف النتيجة بنجاح" });

  } catch (error) {
    console.error("Delete error:", error);
    return res.status(500).json({ success: false, message: error.message });
  }
});

// ========== View Route ==========
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
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    let contentType = 'application/octet-stream';
    const fileExtension = filename.split('.').pop().toLowerCase();
    
    switch (fileExtension) {
      case 'pdf': contentType = 'application/pdf'; break;
      case 'jpg': case 'jpeg': contentType = 'image/jpeg'; break;
      case 'png': contentType = 'image/png'; break;
      case 'doc': contentType = 'application/msword'; break;
      case 'docx': contentType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'; break;
    }

    if (isDownload) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    }
    
    res.setHeader('Content-Type', contentType);
    response.data.pipe(res);

  } catch (error) {
    console.error("Error in /view/:id:", error.message);
    res.status(500).send("حدث خطأ أثناء معالجة الملف");
  }
});

// ========== TELEGRAM APIs ==========

app.get("/api/numbers", async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: "غير مصرح" });
  }
  
  try {
    const snapshot = await db.collection("bot_numbers").orderBy("createdAt", "desc").limit(300).get();
    return res.json({ items: snapshot.docs.map(d => d.data()) });
  } catch (e) {
    console.error("numbers/get error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/numbers", async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: "غير مصرح" });
  }
  
  try {
    const phone = normalizePhone(req.body?.phone);
    if (!phone) return res.status(400).json({ error: "رقم غير صحيح" });

    await db.collection("bot_numbers").doc(phone).set({
      phone,
      createdAt: new Date().toISOString(),
    });

    return res.json({ ok: true, phone });
  } catch (e) {
    console.error("numbers/post error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.delete("/api/numbers/:phone", async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: "غير مصرح" });
  }
  
  try {
    const phone = normalizePhone(req.params.phone);
    await db.collection("bot_numbers").doc(phone).delete();
    return res.json({ ok: true });
  } catch (e) {
    console.error("numbers/delete error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/send-telegram", async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: "غير مصرح" });
  }
  
  try {
    const phone = normalizePhone(req.body?.phone);
    const message = String(req.body?.message || "").trim();
    
    if (!phone) return res.status(400).json({ error: "رقم غير صحيح" });
    if (!message) return res.status(400).json({ error: "الرسالة مطلوبة" });

    const chatsSnap = await db
      .collection("telegram_subscribers")
      .doc(phone)
      .collection("chats")
      .get();

    if (chatsSnap.empty) {
      return res.status(404).json({
        error: "هذا الرقم لم يراسل البوت بعد."
      });
    }

    let delivered = 0;
    let failed = 0;

    for (const doc of chatsSnap.docs) {
      const data = doc.data() || {};
      const chatId = data.chatId || doc.id;
      try {
        await sendTelegramMessage(chatId, message);
        delivered++;
      } catch (e) {
        failed++;
      }
    }

    return res.json({ ok: true, delivered, failed });
  } catch (e) {
    console.error("send-telegram error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/notify-patient", async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: "غير مصرح" });
  }
  
  try {
    const { resultId, customMessage } = req.body;
    if (!resultId) return res.status(400).json({ error: "معرف النتيجة مطلوب" });

    const doc = await db.collection("results").doc(resultId).get();
    if (!doc.exists) {
      return res.status(404).json({ error: "النتيجة غير موجودة" });
    }

    const patient = doc.data();
    const phone = normalizePhone(patient.phone);
    
    const chatsSnap = await db
      .collection("telegram_subscribers")
      .doc(phone)
      .collection("chats")
      .get();

    if (chatsSnap.empty) {
      return res.status(404).json({
        error: `الرقم ${phone} لم يسجل في البوت بعد`
      });
    }

    const defaultMessage = `📋 مرحباً ${patient.name}\n\nتم إضافة نتيجة تحليل ${patient.test} الخاصة بك.`;
    const message = customMessage || defaultMessage;
    
    const protocol = req.protocol === 'https' ? 'https' : 'http';
    const host = req.get('host');
    const link = `${protocol}://${host}/view/${resultId}`;
    const fullMessage = `${message}\n\n🔗 ${link}`;

    let delivered = 0;
    for (const chatDoc of chatsSnap.docs) {
      const chatId = chatDoc.data().chatId || chatDoc.id;
      try {
        await sendTelegramMessage(chatId, fullMessage);
        delivered++;
      } catch (e) {
        console.error(`Failed to send to ${chatId}:`, e.message);
      }
    }

    return res.json({ ok: true, delivered });
  } catch (e) {
    console.error("notify-patient error:", e);
    return res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/telegram/webhook", async (req, res) => {
  try {
    const update = req.body || {};
    const msg = update.message;
    if (!msg?.text) return res.status(200).json({ ok: true });

    const chatId = msg.chat?.id;
    const phone = normalizePhone(msg.text);
    if (!phone || phone.length < 7) return res.status(200).json({ ok: true });

    const allowed = await db.collection("bot_numbers").doc(phone).get();

    if (allowed.exists) {
      await db
        .collection("telegram_subscribers")
        .doc(phone)
        .set({ phone, updatedAt: new Date().toISOString() }, { merge: true });

      await db
        .collection("telegram_subscribers")
        .doc(phone)
        .collection("chats")
        .doc(String(chatId))
        .set({
          chatId,
          addedAt: new Date().toISOString(),
          username: msg.from?.username || null,
          first_name: msg.from?.first_name || null,
          last_name: msg.from?.last_name || null,
        }, { merge: true });

      await sendTelegramMessage(chatId, "✅ تم تسجيل رقمك بنجاح في النظام");
    } else {
      await sendTelegramMessage(chatId, "❌ هذا الرقم غير مسجل في النظام");
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error("[telegram/webhook]", e);
    return res.status(200).json({ ok: true });
  }
});

// ========== SMTP / EMAIL APIs ==========

// إرسال إيميل يدوي
app.post("/api/send-email-manual", async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: "غير مصرح" });
  }

  try {
    const { to, name, subject, body } = req.body;
    
    if (!to || !subject || !body) {
      return res.status(400).json({ error: "جميع الحقول مطلوبة" });
    }

    const html = `
      <div dir="rtl" style="font-family: Tahoma, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
        <h2 style="color: #2a5298;">مرحباً ${name || 'عميلنا العزيز'}</h2>
        <div style="margin: 20px 0;">${body.replace(/\n/g, '<br>')}</div>
        <hr>
        <p style="color: #666; font-size: 12px;">مع تحيات مركز التحاليل الطبية</p>
      </div>
    `;

    await transporter.sendMail({
      from: process.env.EMAIL_ADDRESS,
      to: to,
      subject: subject,
      html: html
    });

    await db.collection("email_logs").add({
      to: to,
      subject: subject,
      date: new Date().toISOString(),
      status: "sent",
      type: "manual"
    });

    return res.json({ ok: true, message: "تم الإرسال" });
  } catch (error) {
    console.error("send-email-manual error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// إرسال إيميل جماعي لقائمة مخصصة
app.post("/api/send-bulk-email", async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: "غير مصرح" });
  }

  try {
    const { recipients, subject, body } = req.body;
    
    if (!recipients || !recipients.length || !subject || !body) {
      return res.status(400).json({ error: "المستلمين والموضوع والمحتوى مطلوبة" });
    }

    let sent = 0;
    let failed = 0;

    for (const recipient of recipients) {
      if (!recipient.email) continue;
      
      try {
        const html = `
          <div dir="rtl" style="font-family: Tahoma, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
            <h2 style="color: #2a5298;">مرحباً ${recipient.name || 'عميلنا العزيز'}</h2>
            <div style="margin: 20px 0;">${body.replace(/\n/g, '<br>')}</div>
            <hr>
            <p style="color: #666; font-size: 12px;">مع تحيات مركز التحاليل الطبية</p>
          </div>
        `;

        await transporter.sendMail({
          from: process.env.EMAIL_ADDRESS,
          to: recipient.email,
          subject: subject,
          html: html
        });

        sent++;
        
        await db.collection("email_logs").add({
          to: recipient.email,
          subject: subject,
          date: new Date().toISOString(),
          status: "sent",
          type: "bulk_custom"
        });
        
        await new Promise(r => setTimeout(r, 500));
        
      } catch (err) {
        failed++;
        console.error(`Failed to send to ${recipient.email}:`, err.message);
      }
    }

    return res.json({ ok: true, total: recipients.length, sent, failed });
  } catch (error) {
    console.error("send-bulk-email error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// إرسال إيميل نتيجة جاهزة
app.post("/api/send-email", async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: "غير مصرح" });
  }

  try {
    const { to, name, resultId } = req.body;
    
    const protocol = req.protocol === 'https' ? 'https' : 'http';
    const host = req.get('host');
    const link = `${protocol}://${host}/view/${resultId}`;
    
    const subject = "نتيجة التحليل جاهزة";
    const body = `
      <p>تم تجهيز نتيجة التحليل الخاصة بك.</p>
      <p>يمكنك الاطلاع عليها من خلال الرابط التالي:</p>
      <p style="text-align: center;">
        <a href="${link}" style="display: inline-block; background: #2a5298; color: white; padding: 10px 20px; border-radius: 8px; text-decoration: none;">📄 عرض النتيجة</a>
      </p>
    `;
    
    const html = `
      <div dir="rtl" style="font-family: Tahoma, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
        <h2 style="color: #2a5298;">مرحباً ${name || 'عميلنا العزيز'}</h2>
        ${body}
        <hr>
        <p style="color: #666; font-size: 12px;">مع تحيات مركز التحاليل الطبية</p>
      </div>
    `;

    await transporter.sendMail({
      from: process.env.EMAIL_ADDRESS,
      to: to,
      subject: subject,
      html: html
    });

    await db.collection("email_logs").add({
      to: to,
      subject: subject,
      date: new Date().toISOString(),
      status: "sent",
      type: "result_notification",
      resultId: resultId
    });

    return res.json({ ok: true, message: "تم الإرسال" });
  } catch (error) {
    console.error("send-email error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// جلب سجل الإيميلات
app.get("/api/email-logs", async (req, res) => {
  if (!req.session.loggedIn) {
    return res.status(401).json({ error: "غير مصرح" });
  }

  try {
    const snapshot = await db.collection("email_logs").orderBy("date", "desc").limit(100).get();
    const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return res.json({ logs });
  } catch (error) {
    console.error("email-logs error:", error);
    return res.status(500).json({ error: error.message });
  }
});

// Check session endpoint (للحفاظ على الجلسة)
app.get("/api/check-session", (req, res) => {
  if (req.session && req.session.loggedIn) {
    req.session.touch();
    return res.json({ loggedIn: true });
  }
  return res.json({ loggedIn: false });
});

module.exports = app;
