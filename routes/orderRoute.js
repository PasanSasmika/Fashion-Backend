import express from 'express';
import { createOrder, generateOrderPDF, getOrderDetails, handlePayHereCallback, sendOrderEmail } from '../controllers/orderController.js';

const orderRouter = express.Router();

orderRouter.post("/", createOrder);
orderRouter.get("/:orderId", getOrderDetails);
orderRouter.post("/notify", handlePayHereCallback); // For POST notifications
orderRouter.get("/notify", handlePayHereCallback); // For redirects
orderRouter.post("/:orderId/send-email", sendOrderEmail);
orderRouter.get("/:orderId/generate-pdf", generateOrderPDF); 
export default orderRouter;