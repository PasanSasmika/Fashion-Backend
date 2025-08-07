import crypto from 'crypto';
import dotenv from 'dotenv';
import Product from "../models/productModel.js";
import Order from '../models/orderModel.js';
import nodemailer from 'nodemailer';

dotenv.config();

const PAYHERE_MERCHANT_ID = process.env.PAYHERE_MERCHANT_ID;
const PAYHERE_SECRET = process.env.PAYHERE_SECRET;

// Email transporter setup
const transporter = nodemailer.createTransport({
  service: process.env.EMAIL_SERVICE,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
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
    
    if (expectedSig !== md5sig) {
      console.error('Hash mismatch!');
      console.log('Expected:', expectedSig);
      console.log('Received:', md5sig);
      return res.status(400).send('Invalid signature');
    }

    const order = await Order.findOne({ orderId: order_id }).populate('userId', 'email');
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
      await order.save();

      // Send email to user
      if (order.userId && order.userId.email) {
        const mailOptions = {
          from: process.env.EMAIL_USER,
          to: order.userId.email,
          subject: 'Order Payment Successful',
          text: `Dear customer,\n\nYour order ${order.orderId} has been successfully paid.\nTotal Amount: LKR ${order.totalAmount.toFixed(2)}\n\nThank you for shopping with us!`
        };

        transporter.sendMail(mailOptions, (error, info) => {
          if (error) {
            console.error('Error sending email:', error);
          } else {
            console.log('Email sent:', info.response);
          }
        });
      }
    } else {
      order.status = 'Failed';
      await order.save();
    }

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