const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
    userId: { type: Number, required: true },
    refId: { type: String, required: true, unique: true }, // ID Transaksi VMP
    status: { type: String, enum: ['PENDING', 'SUCCESS', 'FAILED', 'EXPIRED'], default: 'PENDING' },
    
    produkInfo: { 
        type: { type: String, enum: ['PRODUCT', 'TOPUP'], default: 'PRODUCT' },
        kategori: String,
        namaProduk: String,
        jumlah: Number,
        hargaSatuan: Number,
    },
    
    totalBayar: { type: Number, required: true },
    metodeBayar: { type: String, enum: ['QRIS', 'SALDO'], required: true },
    waktuDibuat: { type: Date, default: Date.now },
});

const Transaction = mongoose.model('Transaction', transactionSchema);
module.exports = Transaction;