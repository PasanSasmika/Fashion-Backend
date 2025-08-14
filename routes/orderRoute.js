import express from 'express';
import { createOrder, generateOrderPDF, getAllOrders, getOrderDetails, getOrdersByUserId, handlePayHereCallback, sendOrderEmail } from '../controllers/orderController.js';

const orderRouter = express.Router();

orderRouter.post("/", createOrder);
orderRouter.get("/", getAllOrders);
orderRouter.get("/user/orders", getOrdersByUserId);
orderRouter.get("/:orderId", getOrderDetails);
orderRouter.post("/notify", handlePayHereCallback); 
orderRouter.get("/notify", handlePayHereCallback);
orderRouter.post("/:orderId/send-email", sendOrderEmail);
orderRouter.get("/:orderId/generate-pdf", generateOrderPDF); 
export default orderRouter;