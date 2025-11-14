const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Telegraf } = require('telegraf'); 
const { URLSearchParams } = require('url');

require('dotenv').config();

// --- Import Models ---
// Pastikan path ini sesuai dengan struktur folder Anda: ./models/*.js
const User = require('./models/User'); 
const Product = require('./models/Product'); 
const Transaction = require('./models/Transaction'); 

// --- Konfigurasi dari .env ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY; 
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
// Gunakan process.env.PORT untuk Heroku, atau fallback ke 3001
const PORT = process.env.PORT || process.env.CALLBACK_PORT || 3001; 

if (!BOT_TOKEN || !MONGO_URI || !VIOLET_API_KEY || !VIOLET_SECRET_KEY) {
    console.error("❌ ERROR: Pastikan BOT_TOKEN, MONGO_URI, VIOLET_API_KEY, dan VIOLET_SECRET_KEY terisi di .env");
    process.exit(1);
}

// --- Inisialisasi Bot (Hanya untuk mengirim notifikasi) ---
const bot = new Telegraf(BOT_TOKEN);

// --- Koneksi MongoDB ---
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => {
      console.error("❌ MongoDB Error:", err);
      process.exit(1); 
  });

// --- Inisialisasi Express App ---
const app = express();
// Gunakan raw body parser untuk /webhook/violetpay
app.use('/webhook/violetpay', bodyParser.raw({ type: 'application/x-www-form-urlencoded' }));
app.use(bodyParser.json()); 


// ====================================================
// ====== UTILITY FUNCTIONS (Delivery Logic) ======
// ====================================================

async function deliverProduct(userId, productId) {
    const product = await Product.findById(productId);
    
    if (product && product.kontenProduk.length > 0) {
        const deliveredContent = product.kontenProduk.shift(); 
        
        await Product.updateOne({ _id: productId }, { 
            $set: { kontenProduk: product.kontenProduk }, 
            $inc: { stok: -1, totalTerjual: 1 } 
        });
        
        bot.telegram.sendMessage(userId, 
            `🎉 **Produk Telah Dikirim!**\n\n` +
            `**Produk:** ${product.namaProduk}\n` +
            `**Konten Anda:**\n\`${deliveredContent}\``, 
            { parse_mode: 'Markdown' }
        ).catch(e => console.error(`Gagal kirim konten ke user ${userId}:`, e.message));
        
        return true;
    } else {
        bot.telegram.sendMessage(userId, `⚠️ **Pembelian Berhasil**, namun stok konten habis. Hubungi Admin.`);
        return false;
    }
}


// ====================================================
// ====== VMP CALLBACK ENDPOINT (POST) ================
// ====================================================

app.post('/webhook/violetpay', async (req, res) => {
    
    const bodyString = req.body.toString('utf8');
    const callbackData = Object.fromEntries(new URLSearchParams(bodyString));

    console.log('[VMP CALLBACK RECEIVED]', callbackData);

    const refId = callbackData.ref_kode;
    const vmpStatus = callbackData.status;
    const incomingSignature = callbackData.signature;

    // 1. Validasi Awal, Cari Transaksi, dan Cek Status
    if (!refId || !vmpStatus || !incomingSignature) {
        return res.status(400).send('Missing essential data'); 
    }
    
    const transaction = await Transaction.findOne({ refId: refId });
    
    if (!transaction) {
        console.warn(`⚠️ [VMP WARN] Transaksi tidak ditemukan: ${refId}.`);
        return res.status(200).send('Transaction not found');
    }
    
    if (transaction.status === 'SUCCESS') {
        console.log(`ℹ️ [VMP INFO] Transaksi sudah diproses: ${refId}.`);
        return res.status(200).send('Transaction already processed');
    }

    // 2. Verifikasi Signature VMP (Kunci: Menggunakan Nominal dari DB!)
    const nominalDB = transaction.totalBayar; // Ambil nominal yang terpercaya dari DB
    
    // Formula Signature: refId + API_KEY + nominalDB
    const mySignatureString = refId + VIOLET_API_KEY + nominalDB;
    const calculatedSignature = crypto
        .createHmac("sha256", VIOLET_SECRET_KEY)
        .update(mySignatureString)
        .digest("hex");

    if (calculatedSignature !== incomingSignature) {
        // Jika signature tidak cocok, asumsikan callback palsu atau data rusak
        console.warn(`❌ [VMP WARN] Signature tidak cocok untuk Ref ID: ${refId}. Ditolak. (Nominal Cek: ${nominalDB})`);
        return res.status(200).send('Signature Mismatch but OK to stop retry'); 
    }
    
    // 3. Proses Status SUCCESS (Hanya jika Signature Valid)
    if (vmpStatus === 'SUCCESS') {
        try {
            // A. Update status transaksi
            await Transaction.updateOne({ refId: refId }, { status: 'SUCCESS' });
            
            // B. Ambil User
            const userId = transaction.userId;
            
            // C. Lakukan Delivery (Produk atau Saldo)
            if (transaction.produkInfo.type === 'TOPUP') {
                await User.updateOne({ userId }, { $inc: { saldo: nominalDB, totalTransaksi: 1 } });
                const updatedUser = await User.findOne({ userId });
                
                bot.telegram.sendMessage(userId, 
                    `🎉 **Top Up Saldo Berhasil!**\n` +
                    `Saldo Anda bertambah **Rp ${nominalDB.toLocaleString('id-ID')}**.\n` +
                    `Saldo kini: Rp ${updatedUser.saldo.toLocaleString('id-ID')}.`, 
                    { parse_mode: 'Markdown' }
                );
                
            } else if (transaction.produkInfo.type === 'PRODUCT') {
                const product = await Product.findOne({ namaProduk: transaction.produkInfo.namaProduk });
                if (product) {
                    await deliverProduct(userId, product._id); 
                    await User.updateOne({ userId }, { $inc: { totalTransaksi: 1 } });
                }
            }
            
            console.log(`✅ Transaksi ${refId} (${transaction.produkInfo.type}) berhasil diproses dan dikirim.`);
            
        } catch (error) {
            console.error(`❌ [VMP ERROR] Gagal memproses transaksi ${refId}:`, error);
            return res.status(200).send('Internal Server Error'); 
        }
        
    } else if (vmpStatus === 'FAILED' || vmpStatus === 'EXPIRED') {
        // Logika untuk gagal/expired
        try {
             if (transaction.status === 'PENDING') {
                await Transaction.updateOne({ refId: refId }, { status: vmpStatus });
                bot.telegram.sendMessage(transaction.userId, `⚠️ **Transaksi Dibatalkan/Gagal**\n\nTransaksi ID \`${refId}\` dengan total **Rp ${nominalDB.toLocaleString('id-ID')}** berstatus: **${vmpStatus}**.`, { parse_mode: 'Markdown' });
             }
        } catch (error) {
            console.error(`[VMP ERROR] Gagal update status ${vmpStatus} untuk ${refId}:`, error);
        }
    }
    
    res.status(200).send('OK'); 
});

// HANYA endpoint dummy untuk success redirect dari VMP
app.get('/success', (req, res) => {
    res.send('Pembayaran berhasil! Silakan cek bot Telegram Anda.');
});


// ====================================================
// ====== SERVER LAUNCH (Diperbaiki untuk Heroku) =====
// ====================================================

app.listen(PORT, () => {
    console.log(`🚀 VMP ini code tes bang Server berjalan di port ${PORT}`);
});
