import mongoose from "mongoose";

const productSchema = mongoose.Schema({
    productId : {
        type : String,
        required: true,
        unique: true
    },

    productName: {
        type : String,
        required : true
    },

    altNames: [
        {
            type: String
        }
    ],

    Images : [
        {
            type : String
        }
    ],

    category:{
        type: String,
        required: true
    },

    description : {
        type: String,
        required: true
    },
    reviews: [
        {
            comment: { type: String, required: true },
            firstName:{ type: String },
            lastName:{ type: String},
            createdAt: { type: Date, default: Date.now }
        }
    ],

     sizes: [
    {
      size: { type: String, required: true },
      price: { type: Number, required: true },
      stock: { type: Number, required: true },
    }
  ]
})

const Product = mongoose.model("products", productSchema);

export default Product;