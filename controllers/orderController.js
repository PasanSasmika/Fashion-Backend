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
  tls: {
    rejectUnauthorized: false // For development only, remove in production
  }
});

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

// Generate PDF invoice in memory with improved layout
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

      // PDF content with better formatting
      doc.image('public/logo.png', 50, 45, { width: 50 });
      doc.fillColor('#444444')
         .fontSize(20)
         .text('INVOICE', 200, 50, { align: 'right' });
      
      doc.fontSize(10)
         .text(`Invoice #: ${order.orderId}`, 200, 80, { align: 'right' })
         .text(`Date: ${new Date(order.createdAt).toLocaleDateString()}`, 200, 95, { align: 'right' })
         .moveDown();

      // Horizontal line
      doc.strokeColor('#aaaaaa')
         .lineWidth(1)
         .moveTo(50, 120)
         .lineTo(550, 120)
         .stroke();

      // Customer information
      doc.fontSize(12)
         .text('BILLED TO:', 50, 140)
         .font('Helvetica-Bold')
         .text(`${order.userId.firstName} ${order.userId.lastName}`, 50, 160)
         .font('Helvetica')
         .text(order.userId.email, 50, 175)
         .moveDown();

      // Invoice items table header
      doc.font('Helvetica-Bold')
         .fillColor('#000000')
         .text('DESCRIPTION', 50, 220)
         .text('SIZE', 250, 220)
         .text('QTY', 350, 220)
         .text('PRICE', 450, 220, { align: 'right' })
         .moveDown();

      // Invoice items
      let y = 240;
      order.items.forEach(item => {
        const productName = productMap[item.productId] || 'Unknown Product';
        doc.font('Helvetica')
           .fillColor('#444444')
           .text(productName, 50, y)
           .text(item.size, 250, y)
           .text(item.quantity.toString(), 350, y)
           .text(`LKR ${item.price.toFixed(2)}`, 450, y, { align: 'right' });
        y += 20;
      });

      // Total amount
      doc.moveTo(50, y + 20)
         .lineTo(550, y + 20)
         .stroke();
      
      doc.font('Helvetica-Bold')
         .fillColor('#000000')
         .text('TOTAL AMOUNT:', 350, y + 30)
         .text(`LKR ${order.totalAmount.toFixed(2)}`, 450, y + 30, { align: 'right' });

      // Footer
      doc.fontSize(10)
         .fillColor('#777777')
         .text('Thank you for shopping with FreshNets!', 50, y + 60, { align: 'center' })
         .text('If you have any questions, please contact support@freshnets.com', 50, y + 80, { align: 'center' });

      doc.end();
    } catch (err) {
      console.error('❌ Error in generateInvoicePDF:', err);
      reject(err);
    }
  });
}

// Improved email sending function with better error handling
async function sendOrderConfirmationEmail(email, order, productMap) {
  try {
    // Generate items list for email
    const itemsList = order.items.map(item => {
      const productName = productMap[item.productId] || 'Unknown Product';
      return `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #ddd;">${productName}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">${item.size}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: center;">${item.quantity}</td>
          <td style="padding: 8px; border-bottom: 1px solid #ddd; text-align: right;">LKR ${item.price.toFixed(2)}</td>
        </tr>
      `;
    }).join('');

    // Generate PDF in memory
    const pdfBuffer = await generateInvoicePDF(order, productMap);

    // HTML email template
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd;">
        <div style="text-align: center; margin-bottom: 20px;">
          <h1 style="color: #333;">Order Confirmation</h1>
          <p style="color: #666;">Thank you for your purchase!</p>
        </div>
        
        <div style="margin-bottom: 20px;">
          <p><strong>Order ID:</strong> ${order.orderId}</p>
          <p><strong>Order Date:</strong> ${new Date(order.createdAt).toLocaleDateString()}</p>
          <p><strong>Total Amount:</strong> LKR ${order.totalAmount.toFixed(2)}</p>
        </div>
        
        <h2 style="color: #333; border-bottom: 1px solid #ddd; padding-bottom: 10px;">Order Items</h2>
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
          <thead>
            <tr style="background-color: #f5f5f5;">
              <th style="padding: 8px; text-align: left; border-bottom: 1px solid #ddd;">Product</th>
              <th style="padding: 8px; text-align: center; border-bottom: 1px solid #ddd;">Size</th>
              <th style="padding: 8px; text-align: center; border-bottom: 1px solid #ddd;">Qty</th>
              <th style="padding: 8px; text-align: right; border-bottom: 1px solid #ddd;">Price</th>
            </tr>
          </thead>
          <tbody>
            ${itemsList}
          </tbody>
        </table>
        
        <div style="text-align: center; margin-top: 30px; color: #777; font-size: 14px;">
          <p>Please find your invoice attached. If you have any questions, contact us at support@freshnets.com</p>
          <p>Thank you for shopping with FreshNets!</p>
        </div>
      </div>
    `;

    // Plain text version for email clients that don't support HTML
    const text = `
      Order Confirmation
      ------------------
      
      Thank you for your purchase!
      
      Order ID: ${order.orderId}
      Order Date: ${new Date(order.createdAt).toLocaleDateString()}
      Total Amount: LKR ${order.totalAmount.toFixed(2)}
      
      Order Items:
      ${order.items.map(item => {
        const productName = productMap[item.productId] || 'Unknown Product';
        return `${productName} - Size: ${item.size}, Qty: ${item.quantity}, Price: LKR ${item.price.toFixed(2)}`;
      }).join('\n')}
      
      Please find your invoice attached.
      
      Thank you for shopping with FreshNets!
    `;

    // Send email using Nodemailer
    const mailOptions = {
      from: 'FreshNets <noreply@freshnets.com>',
      to: email,
      subject: `Your Order Confirmation - #${order.orderId}`,
      text: text,
      html: html,
      attachments: [
        {
          filename: `Invoice_${order.orderId}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf'
        }
      ]
    };

    // Verify transporter connection first
    await transporter.verify((error, success) => {
      if (error) {
        console.error('❌ SMTP connection verification failed:', error);
        throw error;
      }
      console.log('✅ SMTP server is ready to take our messages');
    });

    // Send the email
    const info = await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${email}:`, info.messageId);

    return info;
  } catch (error) {
    console.error(`❌ Failed to send email to ${email}:`, {
      message: error.message,
      stack: error.stack,
      response: error.response || 'No response'
    });
    
    // Save the error to the database
    await Order.updateOne(
      { orderId: order.orderId },
      { 
        $push: { 
          emailErrors: { 
            message: error.message,
            stack: error.stack,
            timestamp: new Date() 
          } 
        } 
      }
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

    // Validate items
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Invalid items data" });
    }

    // Create order with additional details
    const order = new Order({
      orderId,
      userId,
      items: items.map(item => ({
        productId: item.productId,
        productName: item.productName,
        size: item.size,
        quantity: item.quantity,
        price: item.price,
        image: item.image
      })),
      totalAmount,
      status: 'Pending',
      emailErrors: [],
      createdAt: new Date(),
      updatedAt: new Date()
    });

    await order.save();

    const paymentData = {
      merchant_id: PAYHERE_MERCHANT_ID,
      return_url: `${process.env.FRONTEND_URL}/order-success/${orderId}`,
      cancel_url: `${process.env.FRONTEND_URL}/order-canceled/${orderId}`,
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
      paymentData,
      orderId
    });
  } catch (error) {
    console.error('💥 Error creating order:', error);
    res.status(500).json({ 
      message: 'Failed to create order',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}

// Handle PayHere server callback with improved email handling
export async function handlePayHereCallback(req, res) {
  const data = req.method === 'POST' ? req.body : req.query;
  console.log("📦 PayHere callback received:", data);

  try {
    // Verify the callback signature
    const expectedSig = generatePayHereCallbackHash(data, PAYHERE_SECRET);

    if (expectedSig !== data.md5sig) {
      console.error('❌ Hash mismatch');
      console.log('Expected:', expectedSig);
      console.log('Received:', data.md5sig);
      return res.status(400).send('Invalid signature');
    }

    // Find and update the order
    const order = await Order.findOne({ orderId: data.order_id }).populate('userId');
    if (!order) {
      console.error('❌ Order not found:', data.order_id);
      return res.status(404).send('Order not found');
    }

    if (data.status_code == '2') {
      // Payment successful
      order.status = 'Paid';
      order.paymentId = data.payment_id;
      order.updatedAt = new Date();

      // Update stock for each item
      const stockUpdatePromises = order.items.map(item => 
        Product.updateOne(
          { productId: item.productId, "sizes.size": item.size },
          { $inc: { "sizes.$.stock": -item.quantity } }
        )
      );
      await Promise.all(stockUpdatePromises);

      // Send confirmation email
      if (order.userId && order.userId.email) {
        console.log("📩 Preparing to send order confirmation to", order.userId.email);

        try {
          // Create product map for email
          const productIds = order.items.map(item => item.productId);
          const products = await Product.find({ productId: { $in: productIds } });
          const productMap = products.reduce((map, product) => {
            map[product.productId] = product.name;
            return map;
          }, {});

          // Send email with retry logic
          let retries = 3;
          while (retries > 0) {
            try {
              await sendOrderConfirmationEmail(order.userId.email, order, productMap);
              break;
            } catch (emailError) {
              retries--;
              if (retries === 0) throw emailError;
              console.log(`Retrying email send (${retries} attempts left)...`);
              await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
            }
          }
        } catch (emailError) {
          console.error('❌ Failed to send order confirmation after retries:', emailError);
          // Continue even if email fails - we don't want to fail the entire payment process
        }
      }
    } else {
      // Payment failed
      order.status = 'Failed';
      order.updatedAt = new Date();
    }

    await order.save();
    res.status(200).send('OK');
  } catch (error) {
    console.error('💥 Error processing payment callback:', error);
    res.status(500).send('Error processing payment');
  }
}

// Get single order details with improved error handling
export async function getOrderDetails(req, res) {
  try {
    const orderId = req.params.orderId;
    const order = await Order.findOne({ orderId })
      .populate('userId', 'firstName lastName email phone')
      .lean();

    if (!order) {
      return res.status(404).json({ 
        success: false,
        message: 'Order not found' 
      });
    }

    // Get product details for each item
    const productIds = order.items.map(item => item.productId);
    const products = await Product.find({ productId: { $in: productIds } }, 'productId name');
    const productMap = products.reduce((map, product) => {
      map[product.productId] = product.name;
      return map;
    }, {});

    // Enhance order items with product names
    const enhancedItems = order.items.map(item => ({
      ...item,
      productName: productMap[item.productId] || item.productName
    }));

    res.json({
      success: true,
      order: {
        ...order,
        items: enhancedItems
      }
    });
  } catch (error) {
    console.error("💥 Error fetching order details:", error);
    res.status(500).json({ 
      success: false,
      message: 'Error fetching order details',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
}