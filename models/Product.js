const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    kategori: { type: String, required: true }, 
    namaProduk: { type: String, required: true, unique: true }, // Tambahkan unique untuk nama produk
    harga: { type: Number, required: true }, 
    stok: { type: Number, default: 0 }, 
    totalTerjual: { type: Number, default: 0 },
    deskripsi: { type: String, default: 'Deskripsi produk.' },
    kontenProduk: [{ type: String }], // Array of strings (keys/accounts)
});

productSchema.index({ kategori: 1 });

const Product = mongoose.model('Product', productSchema);
module.exports = Product;