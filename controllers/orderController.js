import crypto from 'crypto';
import dotenv from 'dotenv';
import Product from "../models/productModel.js";
import Order from '../models/orderModel.js';
import User from "../models/userModel.js";
import nodemailer from 'nodemailer';
import pdfkit from 'pdfkit';
import { fileURLToPath } from 'url';

dotenv.config();

const PAYHERE_MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID;
const PAYHERE_SECRET = process.env.PAYHERE_SECRET;

// Configure Nodemailer with Brevo SMTP
const transporter = nodemailer.createTransport({
  host: process.env.BREVO_HOST,
  port: parseInt(process.env.BREVO_PORT),
  secure: false, // Use TLS
  auth: {
    user: process.env.BREVO_USER,
    pass: process.env.BREVO_PASS
  },
  // Add connection timeout and disable DNS lookup cache
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 10000,
  dnsTimeout: 10000,
  // Enable debug for better error logging
  debug: true,
  logger: true
});

// Verify SMTP connection on startup
transporter.verify((error, success) => {
  if (error) {
    console.error('❌ SMTP connection error:', error);
  } else {
    console.log('✅ SMTP server connection verified');
  }
});

// Resolve __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);

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

// Generate PDF invoice in memory
async function generateInvoicePDF(order, productMap) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new pdfkit();
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfBuffer = Buffer.concat(buffers);
        resolve(pdfBuffer);
      });
      doc.on('error', (err) => {
        console.error('❌ PDF generation error:', err);
        reject(err);
      });

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
    } catch (err) {
      console.error('❌ Error in generateInvoicePDF:', err);
      reject(err);
    }
  });
}

// Email sending function with PDF attachment using Nodemailer and Brevo SMTP
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
    // Generate PDF in memory
    const pdfBuffer = await generateInvoicePDF(order, productMap);

    // Verify transporter before sending
    await new Promise((resolve, reject) => {
      transporter.verify((error, success) => {
        if (error) {
          console.error('❌ SMTP verification failed before sending:', error);
          reject(error);
        } else {
          console.log('✅ SMTP verification successful before sending');
          resolve(success);
        }
      });
    });

    // Send email using Nodemailer
    const info = await transporter.sendMail({
      from: '"FreshNets" <pasansasmika333@gmail.com>', // Ensure this email is verified in Brevo
      to: email,
      subject: `Order Confirmation - ${order.orderId}`,
      html: html,
      attachments: [
        {
          filename: `invoice_${order.orderId}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf'
        }
      ]
    });

    console.log(`✅ Email with invoice sent to ${email}, Message ID: ${info.messageId}`);
    return info;
  } catch (error) {
    console.error(`❌ Failed to send email to ${email}:`, {
      message: error.message,
      stack: error.stack,
      response: error.response || 'No response',
      responseCode: error.responseCode || 'No code'
    });
    await Order.updateOne(
      { orderId: order.orderId },
      { $push: { emailErrors: { message: error.message, timestamp: new Date() } } }
    );
    throw error;
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
      status: 'Pending',
      emailErrors: [] // Initialize emailErrors array
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

    if (data.status_code === '2') {
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
      } else {
        console.error('❌ User or email not found for order:', order.orderId);
        await Order.updateOne(
          { orderId: order.orderId },
          { $push: { emailErrors: { message: 'User or email not found', timestamp: new Date() } } }
        );
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