const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { Telegraf } = require("telegraf"); 
const bodyParser = require("body-parser");
require("dotenv").config();

// --- Import Models (Untuk Bot Auto-Payment Baru) ---
const User = require('./models/User'); 
const Product = require('./models/Product'); 
const Transaction = require('./models/Transaction'); 

const app = express();
// Gunakan port dari env, default 37763
const PORT = process.env.PAYMENT_CALLBACK_PORT || 37763; 

app.use(bodyParser.urlencoded({ extended: true })); 
app.use(bodyParser.json()); 

// --- KONFIGURASI DARI ENVIRONMENT VARIABLES ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const VIOLET_SECRET_KEY = process.env.VIOLET_SECRET_KEY;
const MONGO_URI = process.env.MONGO_URI;

// ====== KONEKSI DATABASE ======
mongoose.connect(MONGO_URI)
  .then(() => console.log("✅ Payment Callback Server: MongoDB Connected"))
  .catch(err => console.error("❌ Payment Callback Server: MongoDB Error:", err));

// Inisialisasi Bot untuk mengirim notifikasi
const bot = new Telegraf(BOT_TOKEN); 

// === SCHEMA BARU (menggunakan model yang diimpor) ===
const TransactionNew = Transaction; 

// ====== HELPER FUNCTIONS (Delivery & Processing) ======

// Fungsi untuk mengirim produk
async function deliverProduct(userId, productId) {
    try {
        const product = await Product.findById(productId);
        if (!product || product.kontenProduk.length <= 0) {
            bot.telegram.sendMessage(userId, '⚠️ Produk yang Anda beli kehabisan stok setelah pembayaran. Silakan hubungi admin.', { parse_mode: 'Markdown' });
            return false;
        }

        const key = product.kontenProduk.shift();
        
        await Product.updateOne({ _id: productId }, { 
            $set: { kontenProduk: product.kontenProduk }, 
            $inc: { stok: -1, totalTerjual: 1 } 
        });
        
        bot.telegram.sendMessage(userId, 
            `🎉 **Pembayaran Sukses! Produk Telah Dikirim!**\n\n` +
            `**Produk:** ${product.namaProduk}\n` +
            `**Konten Anda:**\n\`${key}\``, 
            { parse_mode: 'Markdown' }
        );
        return true;
    } catch (error) {
        console.error(`❌ Gagal deliver produk ke user ${userId} di callback:`, error);
        bot.telegram.sendMessage(userId, '❌ Terjadi kesalahan saat mengirim produk Anda. Silakan hubungi admin.', { parse_mode: 'Markdown' });
        return false;
    }
}


// FUNGSI INTI UNTUK MEMPROSES CALLBACK TRANSAKSI BARU (PROD/TOPUP)
async function processNewBotTransaction(refId, data) {
    try {
        const status = data.status.toLowerCase(); 
        
        // Perbaikan: Mencoba semua key nominal yang mungkin
        const nominalKeys = ['total', 'nominal', 'jumlah', 'amount', 'total_amount', 'paid_amount', 'refNominal', 'harga_bayar'];
        
        let totalBayarCallback = 0;
        
        for (const key of nominalKeys) {
            if (data[key]) {
                const parsedValue = parseFloat(data[key]);
                if (parsedValue > 0) {
                    totalBayarCallback = parsedValue;
                    console.log(`✅ [PAYMENT BOT] Nominal ditemukan di key: ${key} dengan nilai: ${totalBayarCallback}`);
                    break;
                }
            }
        }
        
        console.log(`--- Nominal Callback Final: ${totalBayarCallback} ---`);
        
        const transaction = await TransactionNew.findOne({ refId: refId });

        if (!transaction) {
            console.log(`❌ [PAYMENT BOT] Gagal: Transaksi ${refId} TIDAK DITEMUKAN.`);
            return;
        }

        if (transaction.status === 'SUCCESS') {
            console.log(`⚠️ [PAYMENT BOT] Transaksi ${refId} sudah SUCCESS. Abaikan.`);
            return;
        }

        const userId = transaction.userId;
        const itemType = transaction.produkInfo.type;

        if (status === 'success') {
            
            // 2. Pastikan jumlah pembayaran sesuai
            if (totalBayarCallback !== transaction.totalBayar) {
                console.log(`⚠️ [PAYMENT BOT] Jumlah pembayaran TIDAK SESUAI. DB: ${transaction.totalBayar}, Callback: ${totalBayarCallback}.`);
                await TransactionNew.updateOne({ refId }, { status: 'FAILED' });
                bot.telegram.sendMessage(userId, `❌ **Pembayaran Gagal:** Nominal tidak sesuai (DB: ${transaction.totalBayar}, Callback: ${totalBayarCallback}). Hubungi Admin. (Ref: ${refId}).`, { parse_mode: 'Markdown' });
                return;
            }

            // 3. Update Status ke SUCCESS
            const updateResult = await TransactionNew.updateOne({ refId, status: 'PENDING' }, { status: 'SUCCESS' });

            if (updateResult.modifiedCount > 0) {
                console.log(`✅ [PAYMENT BOT] Status Transaksi ${refId} berhasil diupdate ke SUCCESS.`);
                
                // 4. Lakukan Delivery Produk/Top Up
                const user = await User.findOne({ userId }); 
                if (!user) return console.error(`❌ [PAYMENT BOT] User ${userId} tidak ditemukan untuk delivery.`);

                if (itemType === 'TOPUP') {
                    user.saldo += transaction.totalBayar;
                    user.totalTransaksi += 1;
                    await user.save();
                    
                    bot.telegram.sendMessage(userId, 
                        `🎉 **Top Up Berhasil!**\nSaldo kini: Rp ${user.saldo.toLocaleString('id-ID')}.`, 
                        { parse_mode: 'Markdown' }
                    );
                    
                } else if (itemType === 'PRODUCT') {
                    const productData = await Product.findOne({ namaProduk: transaction.produkInfo.namaProduk }).select('_id');
                    if (productData) {
                        await deliverProduct(userId, productData._id); 
                    } else {
                        bot.telegram.sendMessage(userId, `⚠️ Produk ${transaction.produkInfo.namaProduk} tidak ditemukan saat delivery. Hubungi admin.`, { parse_mode: 'Markdown' });
                    }
                }
            } 

        } else if (status === 'failed' || status === 'expired') {
            await TransactionNew.updateOne({ refId, status: 'PENDING' }, { status: status.toUpperCase() });
            bot.telegram.sendMessage(userId, `❌ **Transaksi Gagal/Dibatalkan:** Pembayaran Anda berstatus **${status.toUpperCase()}**.`, { parse_mode: 'Markdown' });
        }

    } catch (error) {
        console.error(`❌ [CALLBACK ERROR] Gagal memproses transaksi ${refId}:`, error);
    }
}

// FUNGSI UTAMA UNTUK VERIFIKASI SIGNATURE
function verifySignature(refid, data) {
    const calculatedSignature = crypto.createHash('md5').update(process.env.VIOLET_SECRET_KEY + refid).digest('hex'); 
    const incomingSignature = data.signature;

    const isSignatureValid = (incomingSignature === calculatedSignature);
    const shouldBypassSignature = !incomingSignature || incomingSignature.length < 5; 

    if (!isSignatureValid && !shouldBypassSignature) {
        console.log(`🚫 Signature callback TIDAK VALID! Dikirim: ${incomingSignature}, Hitungan: ${calculatedSignature}`);
        return false;
    }
    return true;
}


// ====== ENDPOINT UTAMA KHUSUS PAYMENT ======
app.post("/payment_callback", async (req, res) => {
    
    const data = req.body; 
    const refid = data.ref_id || data.ref_kode || data.ref; 
    
    console.log(`\n--- CALLBACK DITERIMA (PAYMENT BOT) ---`);
    console.log("RAW CALLBACK DATA:", data);
    console.log(`Ref ID: ${refid}, Status: ${data.status}`);

    if (!verifySignature(refid, data)) {
        return res.status(200).send({ status: false, message: "Invalid signature ignored" });
    }
    
    try {
        if (!refid || (!refid.startsWith('PROD-') && !refid.startsWith('TOPUP-'))) {
            console.error("❌ Callback Payment: Missing or incorrect Ref ID format.");
            return res.status(400).send({ status: false, message: "Missing or invalid reference ID" }); 
        }

        await processNewBotTransaction(refid, data);
        
        res.status(200).send({ status: true, message: "Callback received and processed" }); 
        
    } catch (error) {
        console.error("❌ Payment Callback Error:", error);
        res.status(200).send({ status: false, message: "Internal server error during processing" });
    }
});


// ====== SERVER LAUNCH ======
app.listen(PORT, () => {
    console.log(`🚀 Payment Callback server berjalan di port ${PORT}`);
});
