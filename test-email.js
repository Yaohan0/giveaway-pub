require("dotenv").config();
const nodemailer = require("nodemailer");

async function main() {
  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  try {
    await transporter.verify();
    console.log("SMTP login works");

    const info = await transporter.sendMail({
      from: `"Booster Lounge" <${process.env.EMAIL_USER}>`,
      to: "YOUR-OTHER-EMAIL@example.com",
      subject: "Test OTP email",
      text: "Your OTP is 123456",
      html: "<b>Your OTP is 123456</b>",
    });

    console.log("Email sent:", info.messageId);
  } catch (err) {
    console.error("EMAIL ERROR:");
    console.error(err);
  }
}

main();