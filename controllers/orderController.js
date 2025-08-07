import crypto from 'crypto';
import dotenv from 'dotenv';
import Product from "../models/productModel.js";
import Order from '../models/orderModel.js';
import User from '../models/userModel.js';
import nodemailer from 'nodemailer';

dotenv.config();

const PAYHERE_MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID;
const PAYHERE_SECRET = process.env.PAYHERE_SECRET;

// Configure Nodemailer transporter
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false, // Use TLS
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// For INITIAL PAYMENT REQUEST
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

// For CALLBACK VERIFICATION
const generatePayHereCallbackHash = (data, secret) => {
  const hash = crypto.createHash('md5');
  const hashString = Object.keys(data)
    .sort()
    .map(key => `${key}=${data[key]}`)
    .join('&');
  return hash.update(hashString + secret).digest('hex').toUpperCase();
};

// Function to send order confirmation email
const sendOrderConfirmationEmail = async (user, order) => {
  const itemsList = order.items
    .map(item => `
      <li>
        <strong>${item.productName}</strong> (Size: ${item.size}, Quantity: ${item.quantity}) - LKR ${item.price.toFixed(2)}
      </li>
    `)
    .join('');

  const mailOptions = {
    from: `"Fashion Store" <${process.env.EMAIL_USER}>`,
    to: user.email,
    subject: `Order Confirmation - ${order.orderId}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <h2 style="color: #333;">Thank You for Your Order!</h2>
        <p>Dear ${user.firstName} ${user.lastName},</p>
        <p>Your order has been successfully placed. Below are the details:</p>
        <h3>Order Details</h3>
        <ul>
          <li><strong>Order ID:</strong> ${order.orderId}</li>
          <li><strong>Total Amount:</strong> LKR ${order.totalAmount.toFixed(2)}</li>
          <li><strong>Status:</strong> ${order.status}</li>
        </ul>
        <h3>Items Purchased</h3>
        <ul>${itemsList}</ul>
        <p>We will notify you once your order is shipped. Thank you for shopping with us!</p>
        <p>Best regards,<br>Fashion Store Team</p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Order confirmation email sent to ${user.email}`);
  } catch (error) {
    console.error('Error sending email:', error);
    throw new Error('Failed to send order confirmation email');
  }
};

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
    console.error('Error creating order:', error);
    res.status(500).json({ message: 'Failed to create order' });
  }
}

export async function handlePayHereCallback(req, res) {
  const data = req.method === 'POST' ? req.body : req.query;
  const { order_id, payment_id, payhere_amount, status_code, md5sig } = data;
  
  try {
    const verifyData = { ...data };
    delete verifyData.md5sig;
    delete verifyData.signature_method;
    
    const expectedSig = generatePayHereCallbackHash(verifyData, PAYHERE_SECRET);
    
    if (misdemeanorSig !== md5sig) {
      console.error('Hash mismatch!');
      console.log('Expected:', expectedSig);
      console.log('Received:', md5sig);
      return res.status(400).send('Invalid signature');
    }

    const order = await Order.findOne({ orderId: order_id }).populate('userId');
    if (!order) return res.status(404).send('Order not found');

    if (status_code == '2') {
      order.status = 'Paid';
      order.paymentId = payment_id;
      
      for (const item of order.items) {
        await Product.updateOne(
          { productId: item.productId, "sizes.size": item.size },
          { $inc: { "sizes.$.stock": -item.quantity } }
        );
      }

      // Send order confirmation email
      await sendOrderConfirmationEmail(order.userId, order);
    } else {
      order.status = 'Failed';
    }

    await order.save();
    res.status(200).send('OK');
    
  } catch (error) {
    console.error('Error processing payment callback:', error);
    res.status(500).send('Error processing payment');
  }
}

export async function getOrderDetails(req, res) {
  try {
    const orderId = req.params.orderId;
    const order = await Order.findOne({ orderId }).populate('userId', 'firstName lastName email');
    
    if (!order) {
      return res.status(404).json({ message: 'Order not found' });
    }
    
    res.json(order);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching order details' });
  }
}