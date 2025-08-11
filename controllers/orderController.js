import crypto from 'crypto';
import dotenv from 'dotenv';
import Product from "../models/productModel.js";
import Order from '../models/orderModel.js';
import User from "../models/userModel.js";
import nodemailer from 'nodemailer';
import { create } from 'pdfkit';

dotenv.config();

const PAYHERE_MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID;
const PAYHERE_SECRET = process.env.PAYHERE_SECRET;

// Nodemailer transporter setup (Gmail App Password)
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587,
  secure: false, // use TLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false
  }
});

// Verify SMTP connection on server start
transporter.verify()
  .then(() => console.log("✅ SMTP transporter ready to send emails"))
  .catch(err => console.error("❌ SMTP connection error:", err));

// Generate MD5 hash for initial payment
function generatePayHereCheckoutHash(paymentData, secret) {
  const hashedSecret = crypto.createHash('md5')
    .update(secret)
    .digest('hex')
    .toUpperCase();
  const dataString = paymentData.merchant_id +
    paymentData.order_id +
    paymentData.amount +
    paymentData.currency +
    hashedSecret;
  return crypto.createHash('md5')
    .update(dataString)
    .digest('hex')
    .toUpperCase();
}

// Correct PayHere callback hash verification
function generatePayHereCallbackHash(data, secret) {
  const hashedSecret = crypto.createHash('md5')
    .update(secret)
    .digest('hex')
    .toUpperCase();
  const hashString = data.merchant_id +
    data.order_id +
    data.payhere_amount +
    data.payhere_currency +
    data.status_code +
    hashedSecret;
  return crypto.createHash('md5')
    .update(hashString)
    .digest('hex')
    .toUpperCase();
}

// Generate LaTeX content for PDF
function generateOrderConfirmationLatex(order, user, productMap) {
  const itemsList = order.items.map(item => {
    const productName = productMap[item.productId] || 'Unknown Product';
    return `
      \\item ${productName} -- Size: ${item.size}, Quantity: ${item.quantity}
    `;
  }).join('');

  return `
    \\documentclass[a4paper,12pt]{article}
    \\usepackage[utf8]{inputenc}
    \\usepackage{geometry}
    \\geometry{margin=1in}
    \\usepackage{parskip}
    \\usepackage{booktabs}
    \\usepackage{noto}

    \\begin{document}

    \\begin{center}
      \\textbf{\\large FreshNets Order Confirmation}\\\\
      \\vspace{0.5cm}
      Order ID: ${order.orderId}\\\\
      Date: ${new Date().toLocaleDateString()}
    \\end{center}

    \\section*{Customer Details}
    Name: ${user.firstName} ${user.lastName}\\\\
    Email: ${user.email}

    \\section*{Order Details}
    \\begin{tabular}{ll}
      \\toprule
      \\textbf{Total Amount} & ${order.totalAmount} LKR \\\\
      \\textbf{Status} & ${order.status} \\\\
      \\midrule
    \\end{tabular}

    \\section*{Items Purchased}
    \\begin{itemize}
      ${itemsList}
    \\end{itemize}

    \\vspace{1cm}
    Thank you for shopping with FreshNets!

    \\end{document}
  `;
}

// Email sending function with PDF attachment
async function sendOrderConfirmationEmail(email, order, productMap) {
  const itemsList = order.items.map(item => {
    const productName = productMap[item.productId] || 'Unknown Product';
    return `<li>${productName} - Size: ${item.size}, Quantity: ${item.quantity}</li>`;
  }).join('');

  const html = `
    <h1>Order Confirmation</h1>
    <p>Thank you for your purchase!</p>
    <p><strong>Order ID:</strong> ${order.orderId}</p>
    <p><strong>Total Amount:</strong> ${order.totalAmount} LKR</p>
    <h2>Items:</h2>
    <ul>${itemsList}</ul>
    <p>Please find your order confirmation attached as a PDF.</p>
    <p>Thank you for shopping with FreshNets!</p>
  `;

  // Generate LaTeX content
  const user = await User.findById(order.userId);
  const latexContent = generateOrderConfirmationLatex(order, user, productMap);

  // Simulate PDF generation (Note: Actual PDF generation requires a LaTeX compiler like pdflatex)
  // For this example, we'll assume a function `latexToPDFBase64` exists to convert LaTeX to base64-encoded PDF
  // In a real implementation, you would use a library like `pdfkit` or a LaTeX server
  const pdfBase64 = Buffer.from(latexContent).toString('base64'); // Placeholder; replace with actual PDF generation

  try {
    const info = await transporter.sendMail({
      from: `"FreshNets" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Order Confirmation - ${order.orderId}`,
      html,
      attachments: [
        {
          filename: `order-confirmation-${order.orderId}.pdf`,
          content: pdfBase64,
          encoding: 'base64',
          contentType: 'application/pdf'
        }
      ]
    });
    console.log(`✅ Email with PDF sent to ${email}: ${info.messageId}`);
  } catch (error) {
    console.error(`❌ Failed to send email with PDF to ${email}:`, error);
  }
}

// Create order and return PayHere payment data
export async function createOrder(req, res) {
  try {
    const { items, totalAmount } = req.body;
    const userId = req.user._id;
    const orderId = `ORD_${Date.now()}_${Math.floor(Math.random() * 10000)}`;

    if (!userId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const order = new Order({
      orderId,
      userId,
      items,
      totalAmount,
      status: 'Pending'
    });

    await order.save();

    const paymentData = {
      merchant_id: PAYHERE_MERCHANT_ID,
      return_url: `${process.env.FRONTEND_URL}/`,
      cancel_url: `${process.env.FRONTEND_URL}/`,
      notify_url: `${process.env.BACKEND_URL}/api/orders/notify`,
      order_id: orderId,
      items: "Fashion Products",
      amount: totalAmount.toFixed(2),
      currency: "LKR",
      first_name: req.user.firstName,
      last_name: req.user.lastName,
      email: req.user.email,
      phone: req.user.phone || "0771234567",
      address: "No. 123, Main Street",
      city: "Colombo",
      country: "Sri Lanka",
    };

    paymentData.hash = generatePayHereCheckoutHash(paymentData, PAYHERE_SECRET);

    res.json({
      success: true,
      paymentData
    });
  } catch (error) {
    console.error('💥 Error creating order:', error);
    res.status(500).json({ message: 'Failed to create order' });
  }
}

// Handle PayHere server callback
export async function handlePayHereCallback(req, res) {
  const data = req.method === 'POST' ? req.body : req.query;
  console.log("📦 PayHere callback received:", data);

  try {
    const expectedSig = generatePayHereCallbackHash(data, PAYHERE_SECRET);

    if (expectedSig !== data.md5sig) {
      console.error('❌ Hash mismatch');
      console.log('Expected:', expectedSig);
      console.log('Received:', data.md5sig);
      return res.status(400).send('Invalid signature');
    }

    const order = await Order.findOne({ orderId: data.order_id });
    if (!order) return res.status(404).send('Order not found');

    if (data.status_code == '2') {
      order.status = 'Paid';
      order.paymentId = data.payment_id;

      // Update stock
      for (const item of order.items) {
        await Product.updateOne(
          { productId: item.productId, "sizes.size": item.size },
          { $inc: { "sizes.$.stock": -item.quantity } }
        );
      }

      // Fetch user and products for email and PDF
      const user = await User.findById(order.userId);
      if (user && user.email) {
        console.log("📩 Sending order confirmation with PDF to", user.email);

        const productIds = order.items.map(item => item.productId);
        const products = await Product.find({ productId: { $in: productIds } });
        const productMap = products.reduce((map, product) => {
          map[product.productId] = product.name;
          return map;
        }, {});

        await sendOrderConfirmationEmail(user.email, order, productMap);
      }
    } else {
      order.status = 'Failed';
    }

    await order.save();
    res.status(200).send('OK');
  } catch (error) {
    console.error('💥 Error processing payment callback:', error);
    res.status(500).send('Error processing payment');
  }
}

// Get single order details
export async function getOrderDetails(req, res) {
  try {
    const orderId = req.params.orderId;
    const order = await Order.findOne({ orderId }).populate('userId', 'firstName lastName email');

    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    res.json(order);
  } catch (error) {
    console.error("💥 Error fetching order details:", error);
    res.status(500).json({ message: 'Error fetching order details' });
  }
}