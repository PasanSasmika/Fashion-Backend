import express from 'express';
import { createOrder, getOrderDetails, handlePayHereCallback } from '../controllers/orderController.js';

const orderRouter = express.Router();

orderRouter.post("/", createOrder);
orderRouter.get("/:orderId", getOrderDetails);
orderRouter.post("/notify", handlePayHereCallback); // For POST notifications
orderRouter.get("/notify", handlePayHereCallback);  // For redirects
export default orderRouter;