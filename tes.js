const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Telegraf } = require('telegraf'); 
const { URLSearchParams } = require('url'); // Diperlukan untuk parsing body raw

require('dotenv').config();

// --- Import Models ---
// Pastikan folder 'models' ada dan berisi User.js, Product.js, Transaction.js
const User = require('./models/User'); 
const Product = require('./models/Product'); 
const Transaction = require('./models/Transaction'); 

// --- Konfigurasi dari .env ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
// VIOLET_API_KEY diperlukan untuk verifikasi signature: refId + API_KEY + nominal
const VIOLET_API_KEY = process.env.VIOLET_API_KEY; 
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
// Gunakan port khusus untuk callback server
const PORT = process.env.PORT || process.env.CALLBACK_PORT || 3000;

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
// Gunakan raw body parser HANYA untuk endpoint callback, karena VMP mengirim body x-www-form-urlencoded
app.use('/webhook/violetpay', bodyParser.raw({ type: 'application/x-www-form-urlencoded' }));
app.use(bodyParser.json()); 


// ====================================================
// ====== UTILITY FUNCTIONS (Delivery Logic) ======
// ====================================================

/**
 * Mengirim konten produk ke pengguna, mengurangi stok, dan menambah totalTerjual.
 * Fungsi ini disalin dari logic bot Anda.
 */
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
    
    // Convert buffer body (from raw parser) to string and then URLSearchParams
    const bodyString = req.body.toString('utf8');
    const callbackData = Object.fromEntries(new URLSearchParams(bodyString));

    console.log('[VMP CALLBACK RECEIVED]', callbackData);

    const refId = callbackData.ref_kode; // VMP menggunakan ref_kode
    const amount = parseInt(callbackData.nominal);
    const vmpStatus = callbackData.status;
    const incomingSignature = callbackData.signature;

    // Pastikan data penting ada
    if (!refId || !amount || !incomingSignature || !vmpStatus) {
        console.warn('❌ [VMP WARN] Missing required fields (ref_kode, nominal, status, or signature)');
        return res.status(400).send('Missing required fields'); 
    }
    
    // 1. Verifikasi Signature VMP (Kritis!)
    // Signature Formula: refId + API_KEY + nominal (Sesuai dengan logic request di t.js)
    const mySignatureString = refId + VIOLET_API_KEY + amount;
    const calculatedSignature = crypto
        .createHmac("sha256", VIOLET_SECRET_KEY)
        .update(mySignatureString)
        .digest("hex");

    if (calculatedSignature !== incomingSignature) {
        console.warn(`❌ [VMP WARN] Signature tidak cocok untuk Ref ID: ${refId}. Ditolak. Dikirim: ${incomingSignature}, Hitungan: ${calculatedSignature}`);
        // Selalu kirim 200 agar VMP menghentikan retry
        return res.status(200).send('Signature Mismatch but OK to stop retry'); 
    }

    // 2. Proses Status SUCCESS
    if (vmpStatus === 'SUCCESS') {
        try {
            const transaction = await Transaction.findOne({ refId: refId });
            
            if (!transaction) {
                console.warn(`⚠️ [VMP WARN] Transaksi tidak ditemukan: ${refId}.`);
                return res.status(200).send('Transaction not found');
            }
            
            if (transaction.status === 'SUCCESS') {
                console.log(`ℹ️ [VMP INFO] Transaksi sudah diproses: ${refId}.`);
                return res.status(200).send('Transaction already processed');
            }
            
            // Verifikasi Nominal (opsional tapi disarankan)
            if (transaction.totalBayar !== amount) {
                console.warn(`⚠️ [VMP WARN] Nominal tidak sesuai. DB: ${transaction.totalBayar}, Callback: ${amount}. Ref ID: ${refId}.`);
                return res.status(200).send('Nominal mismatch');
            }

            // A. Update status transaksi
            await Transaction.updateOne({ refId: refId }, { status: 'SUCCESS' });
            
            // B. Cari User
            const userId = transaction.userId;
            const user = await User.findOne({ userId });
            const itemType = transaction.produkInfo.type;
            
            // C. Lakukan Delivery (Produk atau Saldo)
            if (itemType === 'TOPUP') {
                // Tambah saldo pengguna & update total transaksi
                await User.updateOne({ userId }, { $inc: { saldo: transaction.totalBayar, totalTransaksi: 1 } });
                const updatedUser = await User.findOne({ userId }); // Ambil data user terbaru untuk notifikasi
                
                bot.telegram.sendMessage(userId, 
                    `🎉 **Top Up Saldo Berhasil!**\n` +
                    `Saldo Anda bertambah **Rp ${transaction.totalBayar.toLocaleString('id-ID')}**.\n` +
                    `Saldo kini: Rp ${updatedUser.saldo.toLocaleString('id-ID')}.`, 
                    { parse_mode: 'Markdown' }
                );
                
            } else if (itemType === 'PRODUCT') {
                const product = await Product.findOne({ namaProduk: transaction.produkInfo.namaProduk });
                if (product) {
                    await deliverProduct(userId, product._id); 
                    // Update total transaksi user
                    await User.updateOne({ userId }, { $inc: { totalTransaksi: 1 } });
                }
            }
            
            console.log(`✅ Transaksi ${refId} (${itemType}) berhasil diproses dan dikirim.`);
            
        } catch (error) {
            console.error(`❌ [VMP ERROR] Gagal memproses transaksi ${refId}:`, error);
            // Tetap kirim 200, penanganan kegagalan harus dilakukan secara manual/monitoring
            return res.status(200).send('Internal Server Error'); 
        }
        
    } else if (vmpStatus === 'FAILED' || vmpStatus === 'EXPIRED') {
        // Logika untuk gagal/expired
        try {
             const transaction = await Transaction.findOne({ refId: refId });
             if (transaction && transaction.status === 'PENDING') {
                await Transaction.updateOne({ refId: refId }, { status: vmpStatus });
                bot.telegram.sendMessage(transaction.userId, `⚠️ **Transaksi Dibatalkan/Gagal**\n\nTransaksi ID \`${refId}\` dengan total **Rp ${transaction.totalBayar.toLocaleString('id-ID')}** berstatus: **${vmpStatus}**.`, { parse_mode: 'Markdown' });
             }
        } catch (error) {
            console.error(`[VMP ERROR] Gagal update status ${vmpStatus} untuk ${refId}:`, error);
        }
    }
    
    // Wajib mengembalikan 200 OK ke VMP agar tidak retry
    res.status(200).send('OK'); 
});

// HANYA endpoint dummy untuk success redirect dari VMP
app.get('/success', (req, res) => {
    res.send('Pembayaran berhasil! Silakan cek bot Telegram Anda.');
});


// ====================================================
// ====== SERVER LAUNCH ===============================
// ====================================================

app.listen(PORT, () => {
    console.log(`🚀 VMP Callback Server berjalan di port ${PORT}`);
});
