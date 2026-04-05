const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const session = require("express-session");
const path = require("path");
const axios = require("axios");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "secret123",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    },
  })
);

app.use(express.static(path.join(__dirname, "public")));

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function verifyTurnstile(token, remoteIp = "") {
  try {
    if (!process.env.TURNSTILE_SECRET) {
      console.error("TURNSTILE_SECRET is missing from .env");
      return false;
    }

    const params = new URLSearchParams();
    params.append("secret", process.env.TURNSTILE_SECRET);
    params.append("response", token);

    if (remoteIp) {
      params.append("remoteip", remoteIp);
    }

    const response = await axios.post(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      params.toString(),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    return response.data.success === true;
  } catch (err) {
    console.error("Turnstile verification error:", err.response?.data || err.message);
    return false;
  }
}

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Please log in first." });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Please log in first." });
  }

  if (req.session.user.role !== "admin") {
    return res.status(403).json({ error: "Admins only." });
  }

  next();
}

app.get("/api/health", async (req, res) => {
  try {
    const conn = await pool.getConnection();
    await conn.query("SELECT 1");
    conn.release();

    res.json({ ok: true, message: "Server and DB are working." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: "Database connection failed." });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const { username, email, password, captchaToken } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: "All fields are required." });
    }

    if (!captchaToken) {
      return res.status(400).json({ error: "Captcha missing." });
    }

    const trimmedUsername = username.trim();
    const trimmedEmail = email.trim().toLowerCase();

    const isValidCaptcha = await verifyTurnstile(captchaToken, req.ip);
    if (!isValidCaptcha) {
      return res.status(400).json({ error: "Captcha failed." });
    }

    const [existingUsers] = await pool.query(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [trimmedEmail]
    );

    if (existingUsers.length > 0) {
      return res.status(400).json({ error: "Email already exists." });
    }

    const [recentPending] = await pool.query(
      `SELECT id, created_at
       FROM pending_registrations
       WHERE email = ?
       ORDER BY id DESC
       LIMIT 1`,
      [trimmedEmail]
    );

    if (recentPending.length > 0) {
      const lastCreated = new Date(recentPending[0].created_at).getTime();
      const now = Date.now();
      const secondsSinceLast = Math.floor((now - lastCreated) / 1000);

      if (secondsSinceLast < 60) {
        return res.status(429).json({
          error: `Please wait ${60 - secondsSinceLast} seconds before requesting another OTP.`,
        });
      }
    }

    const password_hash = await bcrypt.hash(password, 10);
    const otp = generateOtp();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `INSERT INTO pending_registrations
        (username, email, password_hash, otp_code, otp_expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         username = VALUES(username),
         password_hash = VALUES(password_hash),
         otp_code = VALUES(otp_code),
         otp_expires_at = VALUES(otp_expires_at),
         created_at = CURRENT_TIMESTAMP`,
      [trimmedUsername, trimmedEmail, password_hash, otp, otpExpiresAt]
    );

    const info = await transporter.sendMail({
      from: `"Giveaway" <${process.env.EMAIL_USER}>`,
      to: trimmedEmail,
      subject: "Your Giveaway OTP Code",
      text: `Your OTP code is ${otp}. It expires in 10 minutes.`,
      html: `<p>Your OTP code is <b>${otp}</b>.</p><p>It expires in 10 minutes.</p>`,
    });

    console.log("REGISTER OTP SENT:", info.messageId, trimmedEmail);

    return res.json({
      message: "OTP sent. Please verify your email to complete registration.",
    });
  } catch (err) {
    console.error("REGISTER ERROR:", err);
    return res.status(500).json({
      error: "Registration failed.",
      details: err.message,
    });
  }
});

app.post("/api/send-email-otp", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required." });
    }

    const trimmedEmail = email.trim().toLowerCase();

    const [existingUsers] = await pool.query(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [trimmedEmail]
    );

    if (existingUsers.length > 0) {
      return res.status(400).json({ error: "This email is already registered." });
    }

    const [pendingRows] = await pool.query(
      `SELECT id, username, password_hash, created_at
       FROM pending_registrations
       WHERE email = ?
       ORDER BY id DESC
       LIMIT 1`,
      [trimmedEmail]
    );

    if (pendingRows.length === 0) {
      return res.status(404).json({ error: "No pending registration found. Please register again." });
    }

    const lastCreated = new Date(pendingRows[0].created_at).getTime();
    const now = Date.now();
    const secondsSinceLast = Math.floor((now - lastCreated) / 1000);

    if (secondsSinceLast < 60) {
      return res.status(429).json({
        error: `Please wait ${60 - secondsSinceLast} seconds before requesting another OTP.`,
      });
    }

    const otp = generateOtp();
    const otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await pool.query(
      `UPDATE pending_registrations
       SET otp_code = ?, otp_expires_at = ?, created_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [otp, otpExpiresAt, pendingRows[0].id]
    );

    const info = await transporter.sendMail({
      from: `"Giveaway" <${process.env.EMAIL_USER}>`,
      to: trimmedEmail,
      subject: "Your Giveaway OTP Code",
      text: `Your OTP code is ${otp}. It expires in 10 minutes.`,
      html: `<p>Your OTP code is <b>${otp}</b>.</p><p>It expires in 10 minutes.</p>`,
    });

    console.log("RESEND OTP SENT:", info.messageId, trimmedEmail);

    return res.json({ message: "OTP resent to email." });
  } catch (err) {
    console.error("SEND EMAIL OTP ERROR:", err);
    return res.status(500).json({
      error: "Failed to send OTP.",
      details: err.message,
    });
  }
});

app.post("/api/verify-email-otp", async (req, res) => {
  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ error: "Email and OTP are required." });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedOtp = otp.trim();

    const [pendingRows] = await pool.query(
      `SELECT *
       FROM pending_registrations
       WHERE email = ?
       LIMIT 1`,
      [trimmedEmail]
    );

    if (pendingRows.length === 0) {
      return res.status(400).json({ error: "No pending registration found." });
    }

    const pending = pendingRows[0];

    if (pending.otp_code !== trimmedOtp) {
      return res.status(400).json({ error: "Invalid OTP." });
    }

    if (new Date(pending.otp_expires_at) < new Date()) {
      return res.status(400).json({ error: "OTP expired." });
    }

    const [existingUsers] = await pool.query(
      "SELECT id FROM users WHERE email = ? LIMIT 1",
      [trimmedEmail]
    );

    if (existingUsers.length > 0) {
      await pool.query("DELETE FROM pending_registrations WHERE id = ?", [pending.id]);
      return res.status(400).json({ error: "Email already exists." });
    }

    const [result] = await pool.query(
      `INSERT INTO users (username, email, password_hash, is_verified, role)
       VALUES (?, ?, ?, 1, 'user')`,
      [pending.username, pending.email, pending.password_hash]
    );

    await pool.query("DELETE FROM pending_registrations WHERE id = ?", [pending.id]);

    req.session.user = {
      id: result.insertId,
      username: pending.username,
      email: pending.email,
      role: "user",
      is_verified: 1,
    };

    return res.json({ message: "Email verified and account created successfully." });
  } catch (err) {
    console.error("VERIFY OTP ERROR:", err);
    return res.status(500).json({
      error: "Failed to verify OTP.",
      details: err.message,
    });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const trimmedEmail = email.trim().toLowerCase();

    const [rows] = await pool.query(
      "SELECT id, username, email, password_hash, role, is_verified FROM users WHERE email = ? LIMIT 1",
      [trimmedEmail]
    );

    if (rows.length === 0) {
      return res.status(400).json({ error: "Invalid email or password." });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      return res.status(400).json({ error: "Invalid email or password." });
    }

    req.session.user = {
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      is_verified: user.is_verified,
    };

    res.json({
      message: "Logged in successfully.",
      user: req.session.user,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Login failed." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.json({ message: "Logged out successfully." });
  });
});

app.get("/api/me", (req, res) => {
  res.json({ user: req.session.user || null });
});

app.get("/api/giveaways", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT 
        g.id,
        g.title,
        g.description,
        g.prize,
        g.server_name,
        g.winner_count,
        g.start_time,
        g.end_time,
        g.status,
        g.created_at,
        u.username AS host_name,
        (
          SELECT COUNT(*)
          FROM giveaway_entries ge
          WHERE ge.giveaway_id = g.id
        ) AS entrant_count
      FROM giveaways g
      JOIN users u ON g.created_by = u.id
      ORDER BY g.created_at DESC
    `);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load giveaways." });
  }
});

app.post("/api/giveaways", requireAdmin, async (req, res) => {
  try {
    const {
      title,
      description,
      prize,
      server_name,
      winner_count,
      start_time,
      end_time,
      status,
    } = req.body;

    if (!title || !prize || !start_time || !end_time) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    const [result] = await pool.query(
      `INSERT INTO giveaways
      (title, description, prize, server_name, winner_count, start_time, end_time, status, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        title,
        description || "",
        prize,
        server_name || null,
        Number(winner_count) || 1,
        start_time,
        end_time,
        status || "draft",
        req.session.user.id,
      ]
    );

    res.json({ message: "Giveaway created.", giveawayId: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to create giveaway." });
  }
});

app.post("/api/giveaways/:id/join", requireLogin, async (req, res) => {
  try {
    const giveawayId = Number(req.params.id);
    const userId = req.session.user.id;

    const [userRows] = await pool.query(
      "SELECT is_verified FROM users WHERE id = ? LIMIT 1",
      [userId]
    );

    if (userRows.length === 0 || userRows[0].is_verified !== 1) {
      return res.status(403).json({ error: "Please verify your email before joining giveaways." });
    }

    if (req.session.user) {
      req.session.user.is_verified = 1;
    }

    const [giveaways] = await pool.query(
      "SELECT * FROM giveaways WHERE id = ? LIMIT 1",
      [giveawayId]
    );

    if (giveaways.length === 0) {
      return res.status(404).json({ error: "Giveaway not found." });
    }

    const giveaway = giveaways[0];
    const now = new Date();
    const start = new Date(giveaway.start_time);
    const end = new Date(giveaway.end_time);

    if (giveaway.status !== "live") {
      return res.status(400).json({ error: "This giveaway is not live." });
    }

    if (now < start) {
      return res.status(400).json({ error: "This giveaway has not started yet." });
    }

    if (now > end) {
      return res.status(400).json({ error: "This giveaway has already ended." });
    }

    await pool.query(
      "INSERT INTO giveaway_entries (giveaway_id, user_id) VALUES (?, ?)",
      [giveawayId, userId]
    );

    res.json({ message: "Joined giveaway successfully." });
  } catch (err) {
    console.error(err);

    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ error: "You already joined this giveaway." });
    }

    res.status(500).json({ error: "Failed to join giveaway." });
  }
});

app.post("/api/giveaways/:id/draw", requireAdmin, async (req, res) => {
  try {
    const giveawayId = Number(req.params.id);

    const [giveaways] = await pool.query(
      "SELECT * FROM giveaways WHERE id = ? LIMIT 1",
      [giveawayId]
    );

    if (giveaways.length === 0) {
      return res.status(404).json({ error: "Giveaway not found." });
    }

    const giveaway = giveaways[0];

    const [entries] = await pool.query(
      "SELECT user_id FROM giveaway_entries WHERE giveaway_id = ?",
      [giveawayId]
    );

    if (entries.length === 0) {
      return res.status(400).json({ error: "No entries to draw from." });
    }

    const poolEntries = [...entries];
    const winnersNeeded = Math.min(giveaway.winner_count, poolEntries.length);
    const winnerIds = [];

    while (winnerIds.length < winnersNeeded) {
      const randomIndex = Math.floor(Math.random() * poolEntries.length);
      const chosen = poolEntries.splice(randomIndex, 1)[0];
      winnerIds.push(chosen.user_id);
    }

    for (const userId of winnerIds) {
      await pool.query(
        "INSERT IGNORE INTO giveaway_winners (giveaway_id, user_id) VALUES (?, ?)",
        [giveawayId, userId]
      );
    }

    await pool.query(
      "UPDATE giveaways SET status = 'ended' WHERE id = ?",
      [giveawayId]
    );

    res.json({
      message: "Winners drawn successfully.",
      winners: winnerIds,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to draw winners." });
  }
});

app.get("/api/giveaways/:id/winners", async (req, res) => {
  try {
    const giveawayId = Number(req.params.id);

    const [rows] = await pool.query(
      `
      SELECT u.id, u.username
      FROM giveaway_winners gw
      JOIN users u ON gw.user_id = u.id
      WHERE gw.giveaway_id = ?
      ORDER BY gw.selected_at ASC
      `,
      [giveawayId]
    );

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load winners." });
  }
});

app.put("/api/giveaways/:id", requireAdmin, async (req, res) => {
  try {
    const giveawayId = Number(req.params.id);

    const {
      title,
      description,
      prize,
      server_name,
      winner_count,
      start_time,
      end_time,
      status,
    } = req.body;

    const [existing] = await pool.query(
      "SELECT id FROM giveaways WHERE id = ? LIMIT 1",
      [giveawayId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Giveaway not found." });
    }

    if (!title || !prize || !start_time || !end_time) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    await pool.query(
      `UPDATE giveaways
       SET title = ?, description = ?, prize = ?, server_name = ?, winner_count = ?, start_time = ?, end_time = ?, status = ?
       WHERE id = ?`,
      [
        title,
        description || "",
        prize,
        server_name || null,
        Number(winner_count) || 1,
        start_time,
        end_time,
        status || "draft",
        giveawayId,
      ]
    );

    res.json({ message: "Giveaway updated successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update giveaway." });
  }
});

app.delete("/api/giveaways/:id", requireAdmin, async (req, res) => {
  try {
    const giveawayId = Number(req.params.id);

    const [existing] = await pool.query(
      "SELECT id FROM giveaways WHERE id = ? LIMIT 1",
      [giveawayId]
    );

    if (existing.length === 0) {
      return res.status(404).json({ error: "Giveaway not found." });
    }

    await pool.query("DELETE FROM giveaways WHERE id = ?", [giveawayId]);

    res.json({ message: "Giveaway deleted successfully." });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete giveaway." });
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});