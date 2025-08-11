import crypto from 'crypto';
import dotenv from 'dotenv';
import Product from "../models/productModel.js";
import Order from '../models/orderModel.js';
import User from "../models/userModel.js";
import nodemailer from 'nodemailer';
import pdfkit from 'pdfkit';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const PAYHERE_MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID;
const PAYHERE_SECRET = process.env.PAYHERE_SECRET;

// Resolve __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

// Generate PDF invoice
async function generateInvoicePDF(order, productMap) {
  return new Promise((resolve, reject) => {
    const doc = new pdfkit();
    const fileName = `invoice_${order.orderId}.pdf`;
    const filePath = path.join(__dirname, '..', 'invoices', fileName);

    // Ensure invoices directory exists
    const invoicesDir = path.join(__dirname, '..', 'invoices');
    if (!fs.existsSync(invoicesDir)) {
      fs.mkdirSync(invoicesDir, { recursive: true });
    }

    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    // PDF content
    doc.fontSize(20).text('Order Invoice', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(`Order ID: ${order.orderId}`);
    doc.text(`Date: ${new Date().toLocaleDateString()}`);
    doc.moveDown();
    doc.text('Items:', { underline: true });

    order.items.forEach(item => {
      const productName = productMap[item.productId] || 'Unknown Product';
      doc.fontSize(12).text(`${productName} - Size: ${item.size}, Quantity: ${item.quantity}`);
    });

    doc.moveDown();
    doc.text(`Total Amount: ${order.totalAmount} LKR`, { align: 'right' });
    doc.moveDown();
    doc.text('Thank you for shopping with FreshNets!', { align: 'center' });

    doc.end();

    stream.on('finish', () => resolve(filePath));
    stream.on('error', (err) => reject(err));
  });
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
    <p>Please find the invoice attached.</p>
    <p>Thank you for shopping with FreshNets!</p>
  `;

  try {
    // Generate PDF
    const pdfPath = await generateInvoicePDF(order, productMap);

    const info = await transporter.sendMail({
      from: `"FreshNets" <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Order Confirmation - ${order.orderId}`,
      html,
      attachments: [
        {
          filename: `invoice_${order.orderId}.pdf`,
          path: pdfPath,
          contentType: 'application/pdf'
        }
      ]
    });

    console.log(`✅ Email with invoice sent to ${email}: ${info.messageId}`);

    // Clean up PDF file after sending
    fs.unlink(pdfPath, (err) => {
      if (err) console.error(`❌ Failed to delete PDF file: ${err}`);
      else console.log(`🗑️ Deleted PDF file: ${pdfPath}`);
    });
  } catch (error) {
    console.error(`❌ Failed to send email to ${email}:`, error);
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

      // Fetch user and products for email
      const user = await User.findById(order.userId);
      if (user && user.email) {
        console.log("📩 Sending order confirmation to", user.email);

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