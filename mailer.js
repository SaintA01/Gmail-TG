const nodemailer = require('nodemailer');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_EMAIL,
        pass: process.env.GMAIL_APP_PASSWORD
      }
    });
  }
  return transporter;
}

async function sendVerificationEmail(toEmail, verificationCode) {
  const transporter = getTransporter();
  
  const mailOptions = {
    from: `"Gmail Bot" <${process.env.GMAIL_EMAIL}>`,
    to: toEmail,
    subject: 'Your Gmail Verification Code',
    html: `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; }
          .code { 
            font-size: 32px; 
            font-weight: bold; 
            padding: 20px; 
            background: #667eea;
            color: white;
            text-align: center;
            letter-spacing: 5px;
          }
        </style>
      </head>
      <body>
        <h2>Verification Code</h2>
        <div class="code">${verificationCode}</div>
        <p>Enter this code in Telegram to complete verification and earn $0.30.</p>
        <p>Code expires in 10 minutes.</p>
      </body>
      </html>
    `
  };
  
  return await transporter.sendMail(mailOptions);
}

module.exports = { sendVerificationEmail };
