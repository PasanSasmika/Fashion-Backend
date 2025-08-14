import express from 'express';
import { createOrder, generateOrderPDF, getAllOrders, getOrderDetails, handlePayHereCallback, sendOrderEmail, viewOrderByUser } from '../controllers/orderController.js';

const orderRouter = express.Router();

orderRouter.post("/", createOrder);
orderRouter.get("/", getAllOrders);
orderRouter.get("/my-orders", viewOrderByUser);
orderRouter.get("/:orderId", getOrderDetails);
orderRouter.post("/notify", handlePayHereCallback); 
orderRouter.get("/notify", handlePayHereCallback);
orderRouter.post("/:orderId/send-email", sendOrderEmail);
orderRouter.get("/:orderId/generate-pdf", generateOrderPDF); 
export default orderRouter;