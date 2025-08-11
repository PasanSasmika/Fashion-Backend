import crypto from 'crypto';
import dotenv from 'dotenv';
import Product from "../models/productModel.js";
import Order from '../models/orderModel.js';
import User from "../models/userModel.js";
import nodemailer from 'nodemailer';

dotenv.config();

const PAYHERE_MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID;
const PAYHERE_SECRET = process.env.PAYHERE_SECRET;

// Enhanced Nodemailer transporter with better error handling
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: false, // port 587 -> TLS
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  },
  tls: {
    rejectUnauthorized: false
  },
  connectionTimeout: 30000,
  greetingTimeout: 30000,
  socketTimeout: 30000
});

// Verify transporter on startup
transporter.verify((error) => {
  if (error) {
    console.error('❌ SMTP Connection Error:', error);
  } else {
    console.log('✅ SMTP Server is ready to take our messages');
  }
});

// Generate MD5 hash for initial payment
const generatePayHereCheckoutHash = (paymentData, secret) => {
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
};

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

// Async function to update product stock
async function updateProductStock(items) {
  try {
    for (const item of items) {
      await Product.updateOne(
        { productId: item.productId, "sizes.size": item.size },
        { $inc: { "sizes.$.stock": -item.quantity } }
      );
    }
    console.log('✅ Stock updated successfully');
  } catch (error) {
    console.error('❌ Stock update error:', error);
    throw error;
  }
}

// Enhanced email sending function
async function sendOrderConfirmationEmail(email, order, productMap) {
  try {
    const itemsList = order.items.map(item => {
      const productName = productMap[item.productId] || 'Unknown Product';
      return `<li>${productName} - Size: ${item.size}, Quantity: ${item.quantity}, Price: ${item.price} LKR</li>`;
    }).join('');

    const html = `
      <h1>Order Confirmation #${order.orderId}</h1>
      <p>Thank you for your purchase!</p>
      <p><strong>Order Total:</strong> ${order.totalAmount.toFixed(2)} LKR</p>
      <p><strong>Payment Status:</strong> Paid</p>
      <h2>Order Details:</h2>
      <ul>${itemsList}</ul>
      <p>We'll notify you when your items ship.</p>
      <p>Thank you for shopping with FreshNets!</p>
    `;

    const mailOptions = {
      from: `FreshNets <${process.env.SMTP_USER}>`,
      to: email,
      subject: `Your Order #${order.orderId} Confirmation`,
      html,
      headers: {
        'X-Mailer': 'FreshNets Server',
        'Priority': 'high'
      }
    };

    console.log(`📩 Attempting to send email to: ${email}`);
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent successfully to ${email}`, info.messageId);
    return info;
  } catch (error) {
    console.error(`❌ Email send failed to ${email}:`, error);
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
      status: 'Pending'
    });

    await order.save();

    const paymentData = {
      merchant_id: PAYHERE_MERCHANT_ID,
      return_url: `${process.env.FRONTEND_URL}/order/${orderId}`,
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

// Handle PayHere server callback - completely rewritten for reliability
export async function handlePayHereCallback(req, res) {
  const data = req.method === 'POST' ? req.body : req.query;
  console.log("📦 PayHere callback received:", JSON.stringify(data, null, 2));

  try {
    // Validate signature
    const expectedSig = generatePayHereCallbackHash(data, PAYHERE_SECRET);
    if (expectedSig !== data.md5sig) {
      console.error('❌ Hash mismatch');
      console.log('Expected:', expectedSig);
      console.log('Received:', data.md5sig);
      return res.status(400).send('Invalid signature');
    }

    // Find and update order
    const order = await Order.findOne({ orderId: data.order_id });
    if (!order) {
      console.error('❌ Order not found:', data.order_id);
      return res.status(404).send('Order not found');
    }

    // Process payment status
    if (data.status_code == '2') { // Payment successful
      order.status = 'Paid';
      order.paymentId = data.payment_id;
      order.updatedAt = new Date();

      // Get user and product info in parallel
      const [user, products] = await Promise.all([
        User.findById(order.userId),
        Product.find({ productId: { $in: order.items.map(i => i.productId) } })
      ]);

      // Create product map
      const productMap = products.reduce((map, product) => {
        map[product.productId] = product.name;
        return map;
      }, {});

      // Process stock and email in parallel but independently
      Promise.allSettled([
        updateProductStock(order.items),
        user?.email ? sendOrderConfirmationEmail(user.email, order, productMap) : null
      ]).then(results => {
        results.forEach((result, i) => {
          if (result.status === 'rejected') {
            console.error(`❌ Operation ${i} failed:`, result.reason);
          }
        });
      });

      await order.save();
      return res.status(200).send('OK');
    } else { // Payment failed
      order.status = 'Failed';
      await order.save();
      return res.status(200).send('OK');
    }
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

// Test email endpoint (add to your routes)
export async function testEmail(req, res) {
  try {
    const testOrder = {
      orderId: 'TEST_ORDER',
      items: [
        { productId: 'test1', size: 'M', quantity: 1, price: 1000 },
        { productId: 'test2', size: 'L', quantity: 2, price: 1500 }
      ],
      totalAmount: 4000
    };

    const productMap = {
      test1: 'Test Product 1',
      test2: 'Test Product 2'
    };

    await sendOrderConfirmationEmail(process.env.SMTP_USER, testOrder, productMap);
    res.send('Test email sent successfully');
  } catch (error) {
    console.error('Test email error:', error);
    res.status(500).send('Failed to send test email: ' + error.message);
  }
}