const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
    userId: { type: Number, required: true, unique: true },
    username: { type: String, default: 'N/A' },
    saldo: { type: Number, default: 0 },
    totalTransaksi: { type: Number, default: 0 },
    joinDate: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);
module.exports = User;
