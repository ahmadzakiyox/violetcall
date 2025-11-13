const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { Telegraf } = require('telegraf'); 

// Pastikan file .env dimuat
require('dotenv').config();

// --- Import Models (Pastikan jalur sesuai jika server terpisah) ---
const User = require('./models/User'); 
const Product = require('./models/Product'); 
const Transaction = require('./models/Transaction'); 

// --- Konfigurasi dari .env ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const VIOLET_API_KEY = process.env.VIOLET_API_KEY;
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const CALLBACK_PORT = process.env.CALLBACK_PORT || 3001; 

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
// Gunakan raw body parser untuk /webhook/violetpay agar bisa memverifikasi signature
app.use('/webhook/violetpay', bodyParser.raw({ type: 'application/x-www-form-urlencoded' }));
// Gunakan json parser untuk semua rute lain (jika ada)
app.use(bodyParser.json()); 


// ====================================================
// ====== UTILITY FUNCTIONS (Disalin dari t.js) =======
// ====================================================

// Fungsi pengiriman produk (Disalin dari t.js)
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

    // Pastikan data penting ada
    if (!callbackData.ref_kode || !callbackData.nominal || !callbackData.signature || !callbackData.status) {
        console.warn('❌ [VMP WARN] Missing required fields');
        return res.status(400).send('Missing required fields'); 
    }
    
    const refId = callbackData.ref_kode;
    const amount = parseInt(callbackData.nominal);
    const vmpStatus = callbackData.status;

    // 1. Verifikasi Signature VMP (Kritis!)
    // Formula Signature: refId + API_KEY + nominal
    const mySignatureString = refId + VIOLET_API_KEY + amount;
    const calculatedSignature = crypto
        .createHmac("sha256", VIOLET_SECRET_KEY)
        .update(mySignatureString)
        .digest("hex");

    if (calculatedSignature !== callbackData.signature) {
        console.warn(`❌ [VMP WARN] Signature tidak cocok untuk Ref ID: ${refId}. Ditolak.`);
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

            // Update status transaksi
            await Transaction.updateOne({ refId: refId }, { status: 'SUCCESS' });
            
            // Cari User
            const user = await User.findOne({ userId: transaction.userId });
            if (!user) {
                 console.error(`❌ [VMP ERROR] User tidak ditemukan untuk Transaksi ${refId}.`);
                 return res.status(200).send('User not found'); 
            }
            
            const itemType = transaction.produkInfo.type;
            
            // Lakukan Delivery (Produk atau Saldo)
            if (itemType === 'TOPUP') {
                // Tambah saldo pengguna & update total transaksi
                user.saldo += transaction.totalBayar;
                user.totalTransaksi += 1;
                await user.save();
                
                bot.telegram.sendMessage(user.userId, 
                    `🎉 **Top Up Saldo Berhasil!**\n` +
                    `Saldo Anda bertambah **Rp ${transaction.totalBayar.toLocaleString('id-ID')}**.\n` +
                    `Saldo kini: Rp ${user.saldo.toLocaleString('id-ID')}.`, 
                    { parse_mode: 'Markdown' }
                );
                
            } else if (itemType === 'PRODUCT') {
                const product = await Product.findOne({ namaProduk: transaction.produkInfo.namaProduk });
                if (product) {
                    await deliverProduct(user.userId, product._id); 
                    // Update total transaksi user
                    await User.updateOne({ userId: user.userId }, { $inc: { totalTransaksi: 1 } });
                }
            }
            
            console.log(`✅ Transaksi ${refId} (${itemType}) berhasil diproses dan dikirim.`);
            
        } catch (error) {
            console.error(`❌ [VMP ERROR] Gagal memproses transaksi ${refId}:`, error);
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
    
    // Wajib mengembalikan 200 OK ke VMP
    res.status(200).send('OK'); 
});

// HANYA endpoint dummy untuk success redirect dari VMP
app.get('/success', (req, res) => {
    res.send('Pembayaran berhasil! Silakan cek bot Telegram Anda.');
});


// ====================================================
// ====== SERVER LAUNCH ===============================
// ====================================================

app.listen(CALLBACK_PORT, () => {
    console.log(`🌐 VMP Callback Server berjalan di port ${CALLBACK_PORT}`);
});
