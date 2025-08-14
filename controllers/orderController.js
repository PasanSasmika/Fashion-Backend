import crypto from 'crypto';
import dotenv from 'dotenv';
import Product from "../models/productModel.js";
import Order from '../models/orderModel.js';
import User from "../models/userModel.js";
import { fileURLToPath } from 'url';
import PDFDocument from 'pdfkit';
import nodemailer from 'nodemailer';

dotenv.config();

const PAYHERE_MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID;
const PAYHERE_SECRET = process.env.PAYHERE_SECRET;

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
    });

    await order.save();

    const paymentData = {
      merchant_id: PAYHERE_MERCHANT_ID,
      return_url: `${process.env.FRONTEND_URL}/ordered-items/${orderId}`,
      cancel_url: `${process.env.FRONTEND_URL}/cart`,
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
    res.status(500).json({ message: 'Failed to create order', error: error.message });
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
    res.status(500).json({ message: 'Error fetching order details', error: error.message });
  }
}

// Send order details via email
export async function sendOrderEmail(req, res) {
  try {
    const { email } = req.body;
    const orderId = req.params.orderId;

    // Validate email
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ message: 'Invalid email address' });
    }

    // Fetch order
    const order = await Order.findOne({ orderId }).populate('userId', 'firstName lastName email');
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    // Verify SMTP configuration
    if (!process.env.SMTP_HOST || !process.env.SMTP_PORT || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
      console.error('SMTP configuration missing');
      return res.status(500).json({ message: 'Email service configuration error' });
    }

    // Create SMTP transporter
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT),
      secure: process.env.SMTP_PORT === '465', // Use SSL for port 465, STARTTLS for 587
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: {
        rejectUnauthorized: false, // Helps with self-signed certs
      },
    });

    // Email content
    const mailOptions = {
      from: `Fashion Store <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Order Confirmation #${order.orderId}`,
      html: `
        <h1>Order Confirmation</h1>
        <p>Order ID: ${order.orderId}</p>
        <p>Status: ${order.status}</p>
        <p>Total: LKR ${order.totalAmount.toFixed(2)}</p>
        <h2>Items:</h2>
        <ul>
          ${order.items.map(item => `
            <li>
              ${item.productName} - Size: ${item.size}, Quantity: ${item.quantity}, Price: LKR ${item.price.toFixed(2)}
            </li>
          `).join('')}
        </ul>
      `,
    };

    // Send email
    const info = await transporter.sendMail(mailOptions);
    console.log('Email sent successfully:', info.response);
    res.json({ message: 'Email sent successfully' });
  } catch (error) {
    console.error('Error sending email:', {
      message: error.message,
      stack: error.stack,
      details: error.response ? error.response : null,
    });
    res.status(500).json({ 
      message: 'Error sending email', 
      error: error.message,
      details: error.response ? error.response : 'No additional error details',
    });
  }
}

// Generate PDF for order
export async function generateOrderPDF(req, res) {
  try {
    const order = await Order.findOne({ orderId: req.params.orderId });
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }

    const doc = new PDFDocument();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=order_${order.orderId}.pdf`);

    doc.pipe(res);

    doc.fontSize(20).text('Order Confirmation', { align: 'center' });
    doc.moveDown();
    doc.fontSize(14).text(`Order ID: ${order.orderId}`);
    doc.text(`Status: ${order.status}`);
    doc.text(`Total: LKR ${order.totalAmount.toFixed(2)}`);
    doc.moveDown();
    doc.fontSize(16).text('Ordered Items:');
    
    order.items.forEach(item => {
      doc.moveDown(0.5);
      doc.fontSize(12).text(`${item.productName}`);
      doc.text(`Size: ${item.size}, Quantity: ${item.quantity}, Price: LKR ${item.price.toFixed(2)}`);
    });

    doc.end();
  } catch (error) {
    console.error('Error generating PDF:', error);
    res.status(500).json({ message: 'Error generating PDF', error: error.message });
  }
}


  // Get all bookings
export function getAllOrders(req, res) {
  Order.find({})
    .populate('userId', 'firstName lastName email')
    .then((orders) => {
      res.json(orders);
    })
    .catch(err => {
      console.error('Error fetching orders:', err);
      res.status(500).json({ message: 'Error fetching orders' });
    });
}


//Get orders by id

export async function getOrdersByUserId(req, res) {
  try {
    const userId = req.user._id;
    const orders = await Order.find({ userId }).sort({ createdAt: -1 });
    res.json(orders);
  } catch (error) {
    console.error('Error fetching user orders:', error);
    res.status(500).json({ message: 'Error fetching orders', error: error.message });
  }
}